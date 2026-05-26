// ===================================================================
// MainAssemblyController — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// REST controller for the STANDALONE Main-Plan Assembly subsystem
// (Wave A1 of OPTION-A-FULL-SPLIT). Exposes `MainAssemblyService` over
// HTTP under `/v1/main-assembly`.
//
// URL pattern: matches supplement-assembly shape (no `:sourceType`
// segment — type is implicit by route). The path parameter is the
// `DevelopmentPlan.id` UUID for every endpoint.
//
// Locked decisions referenced inline:
//   - Q3=B — standalone; this controller MUST NOT import from
//            `src/book-assembly/`. The dedicated DTOs live under
//            `src/main-assembly/dto/`.
//   - §20.4 — `cancelPublishedVersion` ALWAYS throws
//            `403 MAIN_BOOK_CANNOT_ROLLBACK`. The endpoint exists for
//            API surface symmetry with supplement (which DOES allow
//            cancel) but is permanently disabled at the service layer.
//
// CLAUDE.md compliance:
//   - §4.1 / §18.3 — authority inheritance (admin + super-admin only
//            for write paths; staff allowed for read paths). The
//            actual role check is performed inside the service via
//            `loadAndValidateWorkHistory(...)` — controller-level
//            `RolesGuard` is not used (precedent: book-assembly +
//            supplement-assembly controllers both gate at the service).
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
import { MainAssemblyService } from './main-assembly.service';
import { CorrectMainBookDto } from './dto/correct-main-book.dto';
import { CancelMainBookDto } from './dto/cancel-main-book.dto';
import { BookAssemblyFileService } from 'src/book-assembly/book-assembly-file.service';
//   ^ Q3=B file-service exemption: the on-disk storage layout is the
//   single source of truth; the controller uses the file-service only
//   for `assertPathWithinStorageRoot` before streaming a file. Same
//   exemption noted in `main-assembly.service.ts`.

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

@Controller({ path: 'main-assembly', version: '1' })
@UseGuards(JwtAuthGuard)
export class MainAssemblyController {
  private readonly logger = new Logger(MainAssemblyController.name);

  constructor(
    private readonly mainAssemblyService: MainAssemblyService,
    private readonly fileService: BookAssemblyFileService,
  ) {}

  // ===================================================================
  // Display State / Readiness
  // ===================================================================

  @Get(':developmentPlanId/book-state')
  async getBookDisplayState(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!developmentPlanId) {
      throw new BadRequestException('developmentPlanId จำเป็นต้องระบุ');
    }
    return this.mainAssemblyService.getBookDisplayState(
      developmentPlanId,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanId/readiness')
  async getReadiness(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!developmentPlanId) {
      throw new BadRequestException('developmentPlanId จำเป็นต้องระบุ');
    }
    return this.mainAssemblyService.getReadiness(
      developmentPlanId,
      req.user?.userId,
    );
  }

  // ===================================================================
  // Draft Management
  // ===================================================================

  @Post(':developmentPlanId/draft')
  async createDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Creating main-assembly draft for plan=${developmentPlanId} by user=${userId}`,
    );
    return this.mainAssemblyService.createDraft(developmentPlanId, userId);
  }

  @Get(':developmentPlanId/draft')
  async getActiveDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.mainAssemblyService.getActiveDraft(
      developmentPlanId,
      req.user?.userId,
    );
  }

  @Delete(':developmentPlanId/draft')
  async discardDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Discarding main-assembly draft for plan=${developmentPlanId} by user=${userId}`,
    );
    return this.mainAssemblyService.discardDraft(developmentPlanId, userId);
  }

  // ===================================================================
  // Canceled-Draft Management (CLEANUP wave port from BookAssemblyController)
  // ===================================================================

  @Get(':developmentPlanId/draft/canceled')
  async getCanceledDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    // Returns 200 + null when no canceled draft exists (matches the
    // getCurrentVersion contract).
    const userId = req.user?.userId;
    return this.mainAssemblyService.getCanceledDraft(developmentPlanId, userId);
  }

  @Post(':developmentPlanId/draft/restore')
  async restoreDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Restoring main-assembly draft for plan=${developmentPlanId} by user=${userId}`,
    );
    return this.mainAssemblyService.restoreDraft(developmentPlanId, userId);
  }

  @Delete(':developmentPlanId/draft/canceled')
  async purgeCanceledDraft(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Purging canceled main-assembly draft for plan=${developmentPlanId} by user=${userId}`,
    );
    await this.mainAssemblyService.purgeCanceledDraft(developmentPlanId, userId);
    return { message: 'ลบ draft ที่ยกเลิกแล้วเรียบร้อย' };
  }

  // ===================================================================
  // Part Upload / Generation
  // ===================================================================

  @Post(':developmentPlanId/draft/upload-part/:partNumber')
  @UseInterceptors(FileInterceptor('file', pdfMulterConfig))
  async uploadPart(
    @Param('developmentPlanId') developmentPlanId: string,
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
      `Uploading main-assembly Part ${partNumber} for plan=${developmentPlanId} by user=${userId}`,
    );
    return this.mainAssemblyService.uploadPart(
      developmentPlanId,
      partNumber as 1 | 2,
      file,
      userId,
    );
  }

  @Post(':developmentPlanId/draft/generate-part-3')
  async generatePart3(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Generating main-assembly Part 3 for plan=${developmentPlanId} by user=${userId}`,
    );
    return this.mainAssemblyService.generatePart3(developmentPlanId, userId);
  }

  @Post(':developmentPlanId/draft/reuse-part/:partNumber/from/:versionNumber')
  async reusePart(
    @Param('developmentPlanId') developmentPlanId: string,
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
    return this.mainAssemblyService.reusePart(
      developmentPlanId,
      partNumber as 1 | 2 | 3,
      versionNumber,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanId/draft/parts/:partNumber')
  async viewDraftPart(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (partNumber < 1 || partNumber > 3) {
      throw new BadRequestException('partNumber ต้องเป็น 1, 2 หรือ 3');
    }
    const { absPath, filename } = await this.mainAssemblyService.getDraftPartFile(
      developmentPlanId,
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

  @Post(':developmentPlanId/draft/preview')
  async preview(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    const buffer = await this.mainAssemblyService.preview(
      developmentPlanId,
      req.user?.userId,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="main-plan-preview.pdf"',
    });
    res.end(buffer);
  }

  @Post(':developmentPlanId/draft/merge')
  async merge(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Merging main-assembly for plan=${developmentPlanId} by user=${userId}`,
    );
    return this.mainAssemblyService.merge(developmentPlanId, userId);
  }

  // ===================================================================
  // Version Management
  // ===================================================================

  @Get(':developmentPlanId/versions')
  async getVersions(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.mainAssemblyService.getVersions(
      developmentPlanId,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanId/current')
  async getCurrentVersion(
    @Param('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.mainAssemblyService.getCurrentVersion(
      developmentPlanId,
      req.user?.userId,
    );
  }

  @Get(':developmentPlanId/versions/:versionNumber')
  async getVersionByNumber(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.mainAssemblyService.getVersionByNumber(
      developmentPlanId,
      versionNumber,
      req.user?.userId,
    );
  }

  // ===================================================================
  // Downloads (merged + per-part)
  // ===================================================================

  @Get(':developmentPlanId/versions/:versionNumber/download')
  async downloadMerged(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (versionNumber < 1) {
      throw new BadRequestException('versionNumber ต้องเป็นจำนวนเต็มบวก');
    }
    // Validate read access (404 path) — also resolves version row.
    await this.mainAssemblyService.getVersionByNumber(
      developmentPlanId,
      versionNumber,
      req.user?.userId,
    );
    const absPath = await this.mainAssemblyService.getMergedPdfPath(
      developmentPlanId,
      versionNumber,
    );
    this.fileService.assertPathWithinStorageRoot(absPath);
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="official-main-book-v${versionNumber}.pdf"`,
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

  @Get(':developmentPlanId/versions/:versionNumber/parts/:partNumber')
  async downloadPart(
    @Param('developmentPlanId') developmentPlanId: string,
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
    await this.mainAssemblyService.getVersionByNumber(
      developmentPlanId,
      versionNumber,
      req.user?.userId,
    );
    const absPath = await this.mainAssemblyService.getPartPdfPath(
      developmentPlanId,
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

  @Post(':developmentPlanId/versions/:versionId/correct')
  async correct(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('versionId') versionId: string,
    @Body() dto: CorrectMainBookDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!developmentPlanId) {
      throw new BadRequestException('developmentPlanId จำเป็นต้องระบุ');
    }
    if (!versionId) {
      throw new BadRequestException('versionId จำเป็นต้องระบุ');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `Correct main-assembly plan=${developmentPlanId} version=${versionId} by user=${userId} mode=${dto?.correctionMode}`,
    );
    // Note: the service resolves the current COMPLETED version by
    // (developmentPlanId, status=COMPLETED) — the path `versionId`
    // is used for log-attribution / future versionId-targeted checks.
    return this.mainAssemblyService.correct(developmentPlanId, dto, userId);
  }

  // ===================================================================
  // Cancel Published Version (§20.4 EXEMPTION — always 403)
  // ===================================================================

  @Post(':developmentPlanId/versions/:versionId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelPublishedVersion(
    @Param('developmentPlanId') developmentPlanId: string,
    @Param('versionId') versionId: string,
    @Body() dto: CancelMainBookDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<void> {
    if (!developmentPlanId) {
      throw new BadRequestException('developmentPlanId จำเป็นต้องระบุ');
    }
    if (!versionId) {
      throw new BadRequestException('versionId จำเป็นต้องระบุ');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `[REJECTED 403] Cancel main-assembly version plan=${developmentPlanId} version=${versionId} by user=${userId}`,
    );
    // Service ALWAYS throws — kept here so the route is registered.
    await this.mainAssemblyService.cancelPublishedVersion(
      developmentPlanId,
      versionId,
      dto,
      userId,
    );
  }
}
