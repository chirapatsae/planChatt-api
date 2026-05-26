// ===================================================================
// EditAssemblyController — Wave A2 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// REST controller for the STANDALONE Edit-Revision Assembly subsystem
// (Wave A2 of OPTION-A-FULL-SPLIT). Exposes `EditAssemblyService` over
// HTTP under `/v1/edit-assembly`.
//
// URL pattern: matches the main-assembly / supplement-assembly shape
// (no `:sourceType` segment — type is implicit by route). The path
// parameter is the `DevelopmentPlanRevision.id` UUID for every endpoint.
//
// Locked decisions referenced inline:
//   - Q3=B — standalone; this controller MUST NOT import from
//            `src/book-assembly/`, `src/main-assembly/`, or
//            `src/supplement-assembly/`. The dedicated DTOs live under
//            `src/edit-assembly/dto/`.
//   - §20.2 — `cancelPublishedVersion` is LIVE for EDIT (mirrors
//            supplement). The MAIN_PLAN.cancel exempt cell (§20.4)
//            does NOT apply here; the endpoint executes the deprecate
//            + reset + cascade flow.
//
// CLAUDE.md compliance:
//   - §4.1 / §18.3 — authority inheritance (admin + super-admin only
//            for write paths; staff allowed for read paths). The
//            actual role check is performed inside the service via
//            `loadAndValidateWorkHistory(...)` — controller-level
//            `RolesGuard` is not used (precedent: book-assembly +
//            main-assembly + supplement-assembly controllers all gate
//            at the service).
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
import { EditAssemblyService } from './edit-assembly.service';
import { CorrectEditBookDto } from './dto/correct-edit-book.dto';
import { CancelEditBookDto } from './dto/cancel-edit-book.dto';
import { BookAssemblyFileService } from 'src/book-assembly/book-assembly-file.service';
//   ^ Q3=B file-service exemption: the on-disk storage layout is the
//   single source of truth; the controller uses the file-service only
//   for `assertPathWithinStorageRoot` before streaming a file. Same
//   exemption noted in `edit-assembly.service.ts`.

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

@Controller({ path: 'edit-assembly', version: '1' })
@UseGuards(JwtAuthGuard)
export class EditAssemblyController {
  private readonly logger = new Logger(EditAssemblyController.name);

  constructor(
    private readonly editAssemblyService: EditAssemblyService,
    private readonly fileService: BookAssemblyFileService,
  ) {}

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
    return this.editAssemblyService.getBookDisplayState(
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
    return this.editAssemblyService.getReadiness(
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
      `Creating edit-assembly draft for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.editAssemblyService.createDraft(developmentPlanRevisionId, userId);
  }

  @Get(':developmentPlanRevisionId/draft')
  async getActiveDraft(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.editAssemblyService.getActiveDraft(
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
      `Discarding edit-assembly draft for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.editAssemblyService.discardDraft(developmentPlanRevisionId, userId);
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
    return this.editAssemblyService.getCanceledDraft(
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
      `Restoring edit-assembly draft for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.editAssemblyService.restoreDraft(
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
      `Purging canceled edit-assembly draft for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    await this.editAssemblyService.purgeCanceledDraft(
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
      `Uploading edit-assembly Part ${partNumber} for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.editAssemblyService.uploadPart(
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
      `Generating edit-assembly Part 3 for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.editAssemblyService.generatePart3(developmentPlanRevisionId, userId);
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
    return this.editAssemblyService.reusePart(
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
    const { absPath, filename } = await this.editAssemblyService.getDraftPartFile(
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
    const buffer = await this.editAssemblyService.preview(
      developmentPlanRevisionId,
      req.user?.userId,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="edit-revision-preview.pdf"',
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
      `Merging edit-assembly for revision=${developmentPlanRevisionId} by user=${userId}`,
    );
    return this.editAssemblyService.merge(developmentPlanRevisionId, userId);
  }

  // ===================================================================
  // Version Management
  // ===================================================================

  @Get(':developmentPlanRevisionId/versions')
  async getVersions(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.editAssemblyService.getVersions(
      developmentPlanRevisionId,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanRevisionId/current')
  async getCurrentVersion(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.editAssemblyService.getCurrentVersion(
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
    return this.editAssemblyService.getVersionByNumber(
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
    await this.editAssemblyService.getVersionByNumber(
      developmentPlanRevisionId,
      versionNumber,
      req.user?.userId,
    );
    const absPath = await this.editAssemblyService.getMergedPdfPath(
      developmentPlanRevisionId,
      versionNumber,
    );
    this.fileService.assertPathWithinStorageRoot(absPath);
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="official-edit-book-v${versionNumber}.pdf"`,
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
    await this.editAssemblyService.getVersionByNumber(
      developmentPlanRevisionId,
      versionNumber,
      req.user?.userId,
    );
    const absPath = await this.editAssemblyService.getPartPdfPath(
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
    @Body() dto: CorrectEditBookDto,
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
      `Correct edit-assembly revision=${developmentPlanRevisionId} version=${versionId} by user=${userId} mode=${dto?.correctionMode}`,
    );
    // Note: the service resolves the current COMPLETED version by
    // (developmentPlanRevisionId, status=COMPLETED) — the path
    // `versionId` is used for log-attribution / future versionId-
    // targeted checks.
    return this.editAssemblyService.correct(developmentPlanRevisionId, dto, userId);
  }

  // ===================================================================
  // Cancel Published Version (§20.2 LIVE for EDIT)
  // ===================================================================

  @Post(':developmentPlanRevisionId/versions/:versionId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelPublishedVersion(
    @Param('developmentPlanRevisionId') developmentPlanRevisionId: string,
    @Param('versionId') versionId: string,
    @Body() dto: CancelEditBookDto,
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
      `Cancel edit-assembly version revision=${developmentPlanRevisionId} version=${versionId} by user=${userId}`,
    );
    await this.editAssemblyService.cancelPublishedVersion(
      developmentPlanRevisionId,
      versionId,
      dto,
      userId,
    );
  }
}
