import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { DataSource } from 'typeorm';
import { BulkUploadService } from './bulk-upload.service';
import { BulkUploadTemplateService } from './bulk-upload-template.service';
import { BulkUploadRequestDto } from './dto/bulk-upload-request.dto';
import { BulkUploadTemplateQueryDto } from './dto/bulk-upload-template-query.dto';

/**
 * W113-BE-BATCH — Bulk upload commit endpoints (CLAUDE.md §19).
 * W113-BE-TEMPLATE — Server-rendered XLSX template endpoint (§16 / §19).
 *
 * Routes:
 *   - `POST /project-groups/bulk/validate` — dry-run, validation only.
 *   - `POST /project-groups/bulk`          — commit (atomic for publish,
 *                                            best-effort for draft).
 *   - `GET  /project-groups/bulk/template` — XLSX template, columns
 *                                            chosen from the plan's
 *                                            `reportFormat`.
 *
 * All routes are guarded by `JwtAuthGuard`. The commit / validate
 * routes additionally enforce `workStatus = approved` + scope inside
 * `assertBatchPreconditions`. The template route does the workStatus
 * check directly (it does NOT need plan-phase scope per §19.7 — the
 * template is a read-only authoring assist).
 */
@Controller({
  path: 'project-groups/bulk',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class BulkUploadController {
  constructor(
    private readonly bulkUpload: BulkUploadService,
    private readonly bulkTemplate: BulkUploadTemplateService,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Dry-run validate — used by the FE preview surface (W113-FE-PREVIEW).
   * Performs ZERO writes. The response is the validator's
   * `BulkUploadValidationResult`.
   */
  @Post('validate')
  async validate(
    @Body() dto: BulkUploadRequestDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.bulkUpload.validate(dto, req.user.userId);
  }

  /**
   * Commit — runs the validator + writes inside one transaction, then
   * fires the §17.4 baseline snapshot per published row outside the
   * transaction (advisory per §17.2 — snapshot failures do not undo the
   * commit).
   *
   * On atomic-publish failure (any invalid row) the service throws a
   * `BadRequestException` with code `BULK_VALIDATION_FAILED`. On
   * batch-precondition failure (auth / phase / scope) the validator
   * throws and the global filter maps the structured payload onto the
   * matching 4xx status.
   */
  @Post()
  async commit(
    @Body() dto: BulkUploadRequestDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.bulkUpload.commit(dto, req.user.userId);
  }

  /**
   * Template download — server-rendered XLSX whose columns are chosen
   * from the plan's `reportFormat` per CLAUDE.md §16.5. The response
   * stream is the workbook buffer; the parser may read the embedded
   * hidden `_meta` sheet to detect template/plan mismatches.
   *
   * Authority: JWT + `workStatus = approved`. NO phase / latest / booked
   * gating per §19.7 — template download is a read-only authoring assist.
   */
  @Get('template')
  async template(
    @Query() query: BulkUploadTemplateQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    const userId = req.user.userId;

    // workStatus = approved gate.
    const workHistory = await this.workHistoryLookup.getCurrent(
      this.dataSource.manager,
      userId,
    );
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);

    const { buffer, filename } = await this.bulkTemplate.buildTemplate(
      query.developmentPlanId,
    );

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-store',
    });
    res.end(buffer);
  }
}
