// ===================================================================
// ChangeAssemblyController — Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// REST controller for the STANDALONE Change-Revision Assembly subsystem
// (Wave A3 of OPTION-A-FULL-SPLIT). Exposes `ChangeAssemblyService` over
// HTTP under `/v1/change-assembly`.
//
// URL pattern: matches the main-assembly / edit-assembly /
// supplement-assembly shape (no `:sourceType` segment — type is implicit
// by route). The path parameter is the `DevelopmentPlanRevision.id` UUID
// for every endpoint.
//
// Locked decisions referenced inline:
//   - Q3=B — standalone; this controller MUST NOT import from
//            `src/book-assembly/`, `src/main-assembly/`,
//            `src/edit-assembly/`, or `src/supplement-assembly/`. The
//            dedicated DTOs live under `src/change-assembly/dto/`.
//   - §20.2 — `cancelPublishedVersion` is LIVE for CHANGE (mirrors
//            EDIT and supplement). The MAIN_PLAN.cancel exempt cell
//            (§20.4) does NOT apply here; the endpoint executes the
//            deprecate + reset + cascade flow.
//
// CLAUDE.md compliance:
//   - §4.1 / §18.3 — authority inheritance (admin + super-admin only
//            for write paths; staff allowed for read paths). The
//            actual role check is performed inside the service via
//            `loadAndValidateWorkHistory(...)` — controller-level
//            `RolesGuard` is not used (precedent: book-assembly +
//            main-assembly + edit-assembly + supplement-assembly
//            controllers all gate at the service).
//   - §2 — workStatus = 'approved' re-checked at service entry.
//   - §12 audit — controller does NOT write `tracking_status` rows.
//   - No business logic in handlers — every method delegates.
// ===================================================================

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Request, Response } from 'express';
import * as fs from 'fs';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { ChangeAssemblyService } from './change-assembly.service';
import { CorrectChangeBookDto } from './dto/correct-change-book.dto';
import { CancelChangeBookDto } from './dto/cancel-change-book.dto';
import { BookAssemblyFileService } from 'src/book-assembly/book-assembly-file.service';
//   ^ Q3=B file-service exemption: the on-disk storage layout is the
//   single source of truth; the controller uses the file-service only
//   for `assertPathWithinStorageRoot` before streaming a file. Same
//   exemption noted in `change-assembly.service.ts`.

const pdfMulterConfig = {
  storage: memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req: any, file: Express.Multer.File, cb: any) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new BadRequestException('อนุญาตเฉพาะไฟล์ PDF เท่านั้น'), false);
    }
    cb(null, true);
  },
};

@Controller({ path: 'change-assembly', version: '1' })
@UseGuards(JwtAuthGuard)
export class ChangeAssemblyController {
  private readonly logger = new Logger(ChangeAssemblyController.name);

  constructor(
    private readonly changeAssemblyService: ChangeAssemblyService,
    private readonly fileService: BookAssemblyFileService,
  ) {}

  // ===================================================================
  // Sidebar Counts
  // ===================================================================

  /**
   * Restored 2026-05-29 — §20.10 CLEANUP gap. See
   * `MainAssemblyController.getCounts` for the full rationale.
   * Routed BEFORE parameterized paths so NestJS does not treat
   * `counts` as a UUID param.
   */
  @Get('counts')
  async getCounts(
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<{ actionable: number }> {
    const role = req.user?.role;
    this.logger.log(`Fetching change-assembly counts role=${role}`);
    const actionable =
      await this.changeAssemblyService.getActionableCount(role);
    return { actionable };
  }

  // ===================================================================
  // Display State / Readiness
  // ===================================================================

  @Get(':developmentPlanRevisionId/book-state')
  async getBookDisplayState(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!developmentPlanRevisionId) {
      throw new BadRequestException('developmentPlanRevisionId จำเป็นต้องระบุ');
    }
    return this.changeAssemblyService.getBookDisplayState(
      developmentPlanRevisionId,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanRevisionId/readiness')
  async getReadiness(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!developmentPlanRevisionId) {
      throw new BadRequestException('developmentPlanRevisionId จำเป็นต้องระบุ');
    }
    return this.changeAssemblyService.getReadiness(
      developmentPlanRevisionId,
      req.user?.userId,
    );
  }

  // ===================================================================
  // Draft Management
  // ===================================================================

  @Post(':developmentPlanRevisionId/draft')
  async createDraft(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Creating change-assembly draft for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.changeAssemblyService.createDraft(developmentPlanRevisionId, userId);
  }

  @Get(':developmentPlanRevisionId/draft')
  async getActiveDraft(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.changeAssemblyService.getActiveDraft(
      developmentPlanRevisionId,
      req.user?.userId,
    );
  }

  @Delete(':developmentPlanRevisionId/draft')
  async discardDraft(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Discarding change-assembly draft for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.changeAssemblyService.discardDraft(developmentPlanRevisionId, userId);
  }

  // ===================================================================
  // Canceled-Draft Management (CLEANUP wave port from BookAssemblyController)
  // ===================================================================

  @Get(':developmentPlanRevisionId/draft/canceled')
  async getCanceledDraft(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    // Returns 200 + null when no canceled draft exists (matches the
    // getCurrentVersion contract).
    const userId = req.user?.userId;
    return this.changeAssemblyService.getCanceledDraft(
      developmentPlanRevisionId,
      userId,
    );
  }

  @Post(':developmentPlanRevisionId/draft/restore')
  async restoreDraft(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Restoring change-assembly draft for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.changeAssemblyService.restoreDraft(
      developmentPlanRevisionId,
      userId,
    );
  }

  @Delete(':developmentPlanRevisionId/draft/canceled')
  async purgeCanceledDraft(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Purging canceled change-assembly draft for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    await this.changeAssemblyService.purgeCanceledDraft(
      developmentPlanRevisionId,
      userId,
    );
    return { message: 'ลบ draft ที่ยกเลิกแล้วเรียบร้อย' };
  }

  // ===================================================================
  // Part Upload / Generation
  // ===================================================================

  @Post(':developmentPlanRevisionId/draft/upload-part/:partNumber')
  @UseInterceptors(FileInterceptor('file', pdfMulterConfig))
  async uploadPart(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (partNumber !== 1 && partNumber !== 2) {
      throw new BadRequestException(
        'partNumber ต้องเป็น 1 หรือ 2 (Part 3 ใช้ /draft/generate-part-3)',
      );
    }
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException(`กรุณาแนบไฟล์ PDF สำหรับส่วนที่ ${partNumber}`);
    }
    const userId = req.user?.userId;
    this.logger.log(
      `Uploading change-assembly Part ${partNumber} for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.changeAssemblyService.uploadPart(
      developmentPlanRevisionId,
      partNumber as 1 | 2,
      file,
      userId,
    );
  }

  @Post(':developmentPlanRevisionId/draft/generate-part-3')
  async generatePart3(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Generating change-assembly Part 3 for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.changeAssemblyService.generatePart3(developmentPlanRevisionId, userId);
  }

  @Post(':developmentPlanRevisionId/draft/reuse-part/:partNumber/from/:versionNumber')
  async reusePart(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (partNumber < 1 || partNumber > 3) {
      throw new BadRequestException('partNumber ต้องเป็น 1, 2 หรือ 3');
    }
    if (versionNumber < 1) {
      throw new BadRequestException('versionNumber ต้องเป็นจำนวนเต็มบวก');
    }
    return this.changeAssemblyService.reusePart(
      developmentPlanRevisionId,
      partNumber as 1 | 2 | 3,
      versionNumber,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanRevisionId/draft/parts/:partNumber')
  async viewDraftPart(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (partNumber < 1 || partNumber > 3) {
      throw new BadRequestException('partNumber ต้องเป็น 1, 2 หรือ 3');
    }
    const { absPath, filename } = await this.changeAssemblyService.getDraftPartFile(
      developmentPlanRevisionId,
      partNumber as 1 | 2 | 3,
      req.user?.userId,
    );
    this.fileService.assertPathWithinStorageRoot(absPath);
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': stat.size.toString(),
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(`Stream error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  // ===================================================================
  // Preview & Merge
  // ===================================================================

  @Post(':developmentPlanRevisionId/draft/preview')
  async preview(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    const buffer = await this.changeAssemblyService.preview(
      developmentPlanRevisionId,
      req.user?.userId,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="change-revision-preview.pdf"',
    });
    res.end(buffer);
  }

  @Post(':developmentPlanRevisionId/draft/merge')
  async merge(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Merging change-assembly for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.changeAssemblyService.merge(developmentPlanRevisionId, userId);
  }

  // ===================================================================
  // Version Management
  // ===================================================================

  @Get(':developmentPlanRevisionId/versions')
  async getVersions(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.changeAssemblyService.getVersions(
      developmentPlanRevisionId,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanRevisionId/current')
  async getCurrentVersion(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.changeAssemblyService.getCurrentVersion(
      developmentPlanRevisionId,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanRevisionId/versions/:versionNumber')
  async getVersionByNumber(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.changeAssemblyService.getVersionByNumber(
      developmentPlanRevisionId,
      versionNumber,
      req.user?.userId,
    );
  }

  // ===================================================================
  // Downloads (merged + per-part)
  // ===================================================================

  @Get(':developmentPlanRevisionId/versions/:versionNumber/download')
  async downloadMerged(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (versionNumber < 1) {
      throw new BadRequestException('versionNumber ต้องเป็นจำนวนเต็มบวก');
    }
    // Validate read access (404 path) — also resolves version row.
    await this.changeAssemblyService.getVersionByNumber(
      developmentPlanRevisionId,
      versionNumber,
      req.user?.userId,
    );
    const absPath = await this.changeAssemblyService.getMergedPdfPath(
      developmentPlanRevisionId,
      versionNumber,
    );
    this.fileService.assertPathWithinStorageRoot(absPath);
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="official-change-book-v${versionNumber}.pdf"`,
      'Content-Length': stat.size.toString(),
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(`Stream error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  @Get(':developmentPlanRevisionId/versions/:versionNumber/parts/:partNumber')
  async downloadPart(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (versionNumber < 1) {
      throw new BadRequestException('versionNumber ต้องเป็นจำนวนเต็มบวก');
    }
    if (partNumber < 1 || partNumber > 3) {
      throw new BadRequestException('partNumber ต้องเป็น 1, 2 หรือ 3');
    }
    await this.changeAssemblyService.getVersionByNumber(
      developmentPlanRevisionId,
      versionNumber,
      req.user?.userId,
    );
    const absPath = await this.changeAssemblyService.getPartPdfPath(
      developmentPlanRevisionId,
      versionNumber,
      partNumber as 1 | 2 | 3,
    );
    this.fileService.assertPathWithinStorageRoot(absPath);
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="part-${partNumber}-v${versionNumber}.pdf"`,
      'Content-Length': stat.size.toString(),
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(`Stream error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  // ===================================================================
  // Correct (deprecate current + spawn new draft)
  // ===================================================================

  @Post(':developmentPlanRevisionId/versions/:versionId/correct')
  async correct(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('versionId') versionId: string,
    @Body() dto: CorrectChangeBookDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!developmentPlanRevisionId) {
      throw new BadRequestException('developmentPlanRevisionId จำเป็นต้องระบุ');
    }
    if (!versionId) {
      throw new BadRequestException('versionId จำเป็นต้องระบุ');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `Correct change-assembly revision=${developmentPlanRevisionId} version=${versionId} by user=${userId} mode=${dto?.correctionMode}`,
    );
    // Note: the service resolves the current COMPLETED version by
    // (developmentPlanRevisionId, status=COMPLETED) — the path
    // `versionId` is used for log-attribution / future versionId-
    // targeted checks.
    return this.changeAssemblyService.correct(developmentPlanRevisionId, dto, userId);
  }

  // ===================================================================
  // Cancel Published Version (§20.2 LIVE for CHANGE)
  // ===================================================================

  @Post(':developmentPlanRevisionId/versions/:versionId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelPublishedVersion(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('versionId') versionId: string,
    @Body() dto: CancelChangeBookDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<void> {
    if (!developmentPlanRevisionId) {
      throw new BadRequestException('developmentPlanRevisionId จำเป็นต้องระบุ');
    }
    if (!versionId) {
      throw new BadRequestException('versionId จำเป็นต้องระบุ');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `Cancel change-assembly version revision=${developmentPlanRevisionId} version=${versionId} by user=${userId}`,
    );
    await this.changeAssemblyService.cancelPublishedVersion(
      developmentPlanRevisionId,
      versionId,
      dto,
      userId,
    );
  }
}
