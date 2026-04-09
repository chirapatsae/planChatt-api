import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Request, Response } from 'express';
import * as fs from 'fs';

import { BookAssemblyService } from './book-assembly.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { BookAssemblySourceType } from './enums/book-assembly.enums';
import { CancelBookDto } from './dto/cancel-book.dto';
import { CorrectBookDto } from './dto/correct-book.dto';
import { VersionResponseDto } from './dto/version-response.dto';
import { RevisionReadinessDto } from './dto/revision-readiness.dto';

/** Multer configuration — store in memory for PDF processing */
const pdfMulterConfig = {
  storage: memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req: any, file: Express.Multer.File, cb: any) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new BadRequestException('อนุญาตเฉพาะไฟล์ PDF เท่านั้น'), false);
    }
    cb(null, true);
  },
};

@Controller({ path: 'book-assembly', version: '1' })
@UseGuards(JwtAuthGuard)
export class BookAssemblyController {
  private readonly logger = new Logger(BookAssemblyController.name);

  constructor(private readonly bookAssemblyService: BookAssemblyService) {}

  // ===========================================================================
  // Sidebar Counts & History (MUST be BEFORE parameterized :sourceType routes)
  // ===========================================================================

  @Get('counts')
  async getAssemblyCounts(
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.bookAssemblyService.getAssemblyCounts(userId);
  }

  @Get('history')
  async getAssemblyHistory(
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    const appUrl = process.env.APP_URL ?? '';
    return this.bookAssemblyService.getAssemblyHistory(userId, appUrl);
  }

  // ===========================================================================
  // Display State and Lineage (Rule 6 — MUST be BEFORE :sourceType/:sourceId routes)
  // ===========================================================================

  /**
   * Returns the computed display state for a book source context.
   * Encodes freeze/leaf/publication state for frontend rendering.
   * GET /book-assembly/:sourceType/:sourceId/book-state
   */
  @Get(':sourceType/:sourceId/book-state')
  async getBookDisplayState(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!sourceType || !sourceId) {
      throw new BadRequestException('sourceType และ sourceId จำเป็นต้องระบุ');
    }
    const userId = req.user?.userId;
    return this.bookAssemblyService.getBookDisplayState(sourceType, sourceId, userId);
  }

  /**
   * Returns the full lineage chain for all projects in the current COMPLETED version.
   * GET /book-assembly/:sourceType/:sourceId/lineage
   */
  @Get(':sourceType/:sourceId/lineage')
  async getProjectLineage(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!sourceType || !sourceId) {
      throw new BadRequestException('sourceType และ sourceId จำเป็นต้องระบุ');
    }
    const userId = req.user?.userId;
    return this.bookAssemblyService.getProjectLineage(sourceType, sourceId, userId);
  }

  /**
   * Returns approval progress counts for a revision round.
   * Used by the Edit and Change book pages to render the Part 3 progress bar.
   * Only valid for edit_revision and change_revision sourceType.
   * GET /book-assembly/:sourceType/:sourceId/revision-readiness
   */
  @Get(':sourceType/:sourceId/revision-readiness')
  async getRevisionReadiness(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<RevisionReadinessDto> {
    if (!sourceType || !sourceId) {
      throw new BadRequestException('sourceType และ sourceId จำเป็นต้องระบุ');
    }
    const userId = req.user?.userId;
    return this.bookAssemblyService.getRevisionReadiness(sourceType, sourceId, userId);
  }

  // ===========================================================================
  // Draft Management (Spec Section 14.1)
  // ===========================================================================

  @Post(':sourceType/:sourceId/draft')
  async createDraft(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating draft for ${sourceType}/${sourceId} by user ${userId}`);
    return this.bookAssemblyService.createDraft(sourceType, sourceId, userId);
  }

  @Get(':sourceType/:sourceId/draft')
  async getActiveDraft(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    const draft = await this.bookAssemblyService.getActiveDraft(sourceType, sourceId, userId);
    if (!draft) {
      throw new NotFoundException('ไม่พบ draft ที่กำลังดำเนินการ');
    }
    return draft;
  }

  @Delete(':sourceType/:sourceId/draft')
  async discardDraft(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Discarding draft for ${sourceType}/${sourceId} by user ${userId}`);
    return this.bookAssemblyService.discardDraft(sourceType, sourceId, userId);
  }

  @Get(':sourceType/:sourceId/draft/canceled')
  async getCanceledDraft(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    const draft = await this.bookAssemblyService.getCanceledDraft(sourceType, sourceId, userId);
    if (!draft) {
      throw new NotFoundException('ไม่พบ draft ที่ถูกยกเลิก');
    }
    return draft;
  }

  @Post(':sourceType/:sourceId/draft/restore')
  async restoreDraft(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Restoring draft for ${sourceType}/${sourceId} by user ${userId}`);
    return this.bookAssemblyService.restoreDraft(sourceType, sourceId, userId);
  }

  @Delete(':sourceType/:sourceId/draft/canceled')
  async purgeCanceledDraft(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Purging canceled draft for ${sourceType}/${sourceId} by user ${userId}`);
    await this.bookAssemblyService.purgeCanceledDraft(sourceType, sourceId, userId);
    return { message: 'ลบ draft ที่ยกเลิกแล้วเรียบร้อย' };
  }

  // ===========================================================================
  // Part Upload and Generation (Spec Section 14.2)
  // ===========================================================================

  @Post(':sourceType/:sourceId/draft/part-1')
  @UseInterceptors(FileInterceptor('file', pdfMulterConfig))
  async uploadPart1(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Uploading Part 1 for ${sourceType}/${sourceId} by user ${userId}`);
    return this.bookAssemblyService.uploadPart(sourceType, sourceId, 1, file, userId);
  }

  @Post(':sourceType/:sourceId/draft/part-2')
  @UseInterceptors(FileInterceptor('file', pdfMulterConfig))
  async uploadPart2(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Uploading Part 2 for ${sourceType}/${sourceId} by user ${userId}`);
    return this.bookAssemblyService.uploadPart(sourceType, sourceId, 2, file, userId);
  }

  @Post(':sourceType/:sourceId/draft/part-3/generate')
  async generatePart3(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Generating Part 3 for ${sourceType}/${sourceId} by user ${userId}`);
    return this.bookAssemblyService.generatePart3(sourceType, sourceId, userId);
  }

  @Post(':sourceType/:sourceId/draft/part-:partNumber/reuse/:versionNumber')
  async reusePart(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (partNumber < 1 || partNumber > 3) {
      throw new BadRequestException('partNumber ต้องเป็น 1, 2 หรือ 3');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `Reusing Part ${partNumber} from v${versionNumber} for ${sourceType}/${sourceId} by user ${userId}`,
    );
    return this.bookAssemblyService.reusePart(
      sourceType,
      sourceId,
      partNumber as 1 | 2 | 3,
      versionNumber,
      userId,
    );
  }

  @Get(':sourceType/:sourceId/draft/parts/:partNumber')
  async viewDraftPart(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (partNumber < 1 || partNumber > 3) {
      throw new BadRequestException('partNumber ต้องเป็น 1, 2 หรือ 3');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `View draft part-${partNumber} for ${sourceType}/${sourceId} by user ${userId}`,
    );

    const { absPath, filename } = await this.bookAssemblyService.getDraftPartFile(
      sourceType,
      sourceId,
      partNumber as 1 | 2 | 3,
      userId,
    );

    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': stat.size.toString(),
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(`Stream error viewing draft part-${partNumber}: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  // ===========================================================================
  // Preview and Merge (Spec Section 14.3)
  // ===========================================================================

  @Post(':sourceType/:sourceId/draft/preview')
  async preview(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Preview for ${sourceType}/${sourceId} by user ${userId}`);
    const buffer = await this.bookAssemblyService.preview(sourceType, sourceId, userId);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="preview.pdf"',
    });
    res.end(buffer);
  }

  @Post(':sourceType/:sourceId/draft/merge')
  async merge(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Merge for ${sourceType}/${sourceId} by user ${userId}`);
    const version = await this.bookAssemblyService.merge(sourceType, sourceId, userId);
    const appUrl = process.env.APP_URL ?? '';
    return VersionResponseDto.fromEntity(version, appUrl);
  }

  // ===========================================================================
  // Version Management (Spec Section 14.4)
  // ===========================================================================

  @Get(':sourceType/:sourceId/versions')
  async getVersions(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.bookAssemblyService.getVersions(sourceType, sourceId, userId);
  }

  @Get(':sourceType/:sourceId/current')
  async getCurrentVersion(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.bookAssemblyService.getCurrentVersion(sourceType, sourceId, userId);
  }

  @Get(':sourceType/:sourceId/versions/:versionNumber')
  async getVersionByNumber(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.bookAssemblyService.getVersionByNumber(
      sourceType,
      sourceId,
      versionNumber,
      userId,
    );
  }

  // ===========================================================================
  // Downloads (Spec Section 14.5)
  // ===========================================================================

  @Get(':sourceType/:sourceId/versions/:versionNumber/download')
  async downloadMerged(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (versionNumber < 1) {
      throw new BadRequestException('versionNumber ต้องเป็นจำนวนเต็มบวก');
    }
    const userId = req.user?.userId;
    this.logger.log(`Download merged v${versionNumber} for ${sourceType}/${sourceId} by ${userId}`);

    // Validate read access
    await this.bookAssemblyService.getVersionByNumber(sourceType, sourceId, versionNumber, userId);

    const absPath = this.bookAssemblyService.getMergedPdfPath(sourceType, sourceId, versionNumber);
    const filename = `official-book-v${versionNumber}.pdf`;
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': stat.size.toString(),
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(`Stream error downloading merged v${versionNumber}: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  @Get(':sourceType/:sourceId/versions/:versionNumber/parts/:partNumber')
  async downloadPart(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
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
    const userId = req.user?.userId;
    this.logger.log(
      `Download part-${partNumber} v${versionNumber} for ${sourceType}/${sourceId} by ${userId}`,
    );

    // Validate read access
    await this.bookAssemblyService.getVersionByNumber(sourceType, sourceId, versionNumber, userId);

    const absPath = this.bookAssemblyService.getPartPdfPath(
      sourceType,
      sourceId,
      versionNumber,
      partNumber,
    );
    const filename = `part-${partNumber}-v${versionNumber}.pdf`;
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': stat.size.toString(),
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(`Stream error downloading part-${partNumber} v${versionNumber}: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  // ===========================================================================
  // Cancellation and Correction (Spec Section 14.6)
  // ===========================================================================

  @Post(':sourceType/:sourceId/cancel')
  async cancel(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Body() dto: CancelBookDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Cancel book for ${sourceType}/${sourceId} by user ${userId}`);
    await this.bookAssemblyService.cancel(sourceType, sourceId, dto, userId);
    return { message: 'ยกเลิกเล่มสำเร็จ' };
  }

  @Post(':sourceType/:sourceId/correct')
  async correct(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Body() dto: CorrectBookDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Correct book for ${sourceType}/${sourceId} [mode=${dto.correctionMode}] by user ${userId}`,
    );
    const draft = await this.bookAssemblyService.correct(sourceType, sourceId, dto, userId);
    return {
      message: 'เริ่มการแก้ไขเล่มสำเร็จ — กรุณาดำเนินการอัปโหลดส่วนที่ต้องแก้ไข',
      draftId: draft.id,
      targetVersion: draft.targetVersion,
      correctionMode: draft.correctionMode,
    };
  }

  // ===========================================================================
  // Dev Reset (development environment ONLY)
  // ===========================================================================

  // CRITICAL: dev-reset-all MUST be declared BEFORE :sourceType/:sourceId/dev-reset
  // to avoid NestJS route shadowing.

  @Delete('dev-reset-all')
  async devResetAll(
    @Req() req: Request & { user: JwtPayloadUser },
    @Headers('x-dev-reset-confirm') confirmHeader: string,
  ) {
    // Guard 1: environment check (before anything else)
    if (process.env.NODE_ENV !== 'development') {
      throw new ForbiddenException('This endpoint is only available in the development environment');
    }
    // Guard 2: confirmation header
    if (confirmHeader !== 'CONFIRM_FULL_RESET') {
      throw new BadRequestException('Missing or invalid X-Dev-Reset-Confirm header. Must be: CONFIRM_FULL_RESET');
    }
    // Guard 3: JWT auth — handled by class-level @UseGuards(JwtAuthGuard)
    // Guard 4: super-admin role — enforced inside service
    const userId = req.user?.userId;
    this.logger.warn(`DEV RESET ALL requested by user ${userId}`);

    try {
      const result = await this.bookAssemblyService.resetAllForTesting(userId);
      return { message: 'Full Book Assembly reset complete', ...result };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`DEV RESET ALL failed: ${error?.message}`, error?.stack);
      throw new BadRequestException({ message: 'Reset failed', error: error?.message });
    }
  }

  @Delete(':sourceType/:sourceId/dev-reset')
  async devReset(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Headers('x-dev-reset-confirm') confirmHeader: string,
  ) {
    // Guard 1: environment check (before anything else)
    if (process.env.NODE_ENV !== 'development') {
      throw new ForbiddenException('This endpoint is only available in the development environment');
    }
    // Guard 2: confirmation header
    if (confirmHeader !== 'CONFIRM_RESET') {
      throw new BadRequestException('Missing or invalid X-Dev-Reset-Confirm header. Must be: CONFIRM_RESET');
    }
    // Guard 3: JWT auth — handled by class-level @UseGuards(JwtAuthGuard)
    // Guard 4: super-admin role — enforced inside service
    const userId = req.user?.userId;
    this.logger.warn(`DEV RESET requested for ${sourceType}/${sourceId} by user ${userId}`);

    try {
      const result = await this.bookAssemblyService.resetForTesting(sourceType, sourceId, userId);
      return {
        message: 'Book Assembly data reset complete',
        sourceType,
        sourceId,
        ...result,
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`DEV RESET failed: ${error?.message}`, error?.stack);
      throw new BadRequestException({ message: 'Reset failed', error: error?.message });
    }
  }
}
