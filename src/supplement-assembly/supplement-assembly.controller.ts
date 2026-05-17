// ===================================================================
// SupplementAssemblyController — SUPP_STANDALONE_BE_03
// ===================================================================
//
// REST controller for the STANDALONE Supplement Assembly subsystem
// (Wave 3 of 6). Exposes `SupplementAssemblyService` over HTTP under
// `/v1/supplement-assembly`.
//
// Locked decisions referenced inline:
//   - Q4=C  — Wave A scope: Part1/2/3 + finalize (merge) + cancel.
//             /counts and /history are placeholder stubs returning
//             empty results pending Wave B (see Out of Scope below).
//             /readiness and /book-state are NOT in the BE_02 service
//             surface and are likewise stubbed for future expansion.
//   - Q10=B — standalone; this controller MUST NOT import from
//             `src/book-assembly/`.
//
// CLAUDE.md compliance:
//   - §4.1 / §18.3 — authority inheritance (admin + super-admin only
//             for write paths; staff allowed for read paths). The
//             actual role check is performed inside the service via
//             `loadAndValidateWorkHistory(...)` to keep the precedent
//             aligned with `BookAssemblyController` (no project-wide
//             `RolesGuard` exists today — role gating is service-level).
//   - §2  workStatus = 'approved' — re-checked at service entry per
//             method (controller passes `userId` only).
//   - §12 audit — controller does NOT write `tracking_status` rows.
//   - No business logic in handlers — every method delegates to
//             `SupplementAssemblyService`.
// ===================================================================

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
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
import { SupplementAssemblyService } from './supplement-assembly.service';
import { SupplementAssemblyFileService } from './supplement-assembly-file.service';

/**
 * Multer configuration — memory storage (PDF processing inside service),
 * 50 MB upload cap per BE_03 task spec §3.3. MIME validated upstream of
 * the service for a clearer error message; service re-validates the
 * magic-bytes header defensively.
 */
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

@Controller({ path: 'supplement-assembly', version: '1' })
@UseGuards(JwtAuthGuard)
export class SupplementAssemblyController {
  private readonly logger = new Logger(SupplementAssemblyController.name);

  constructor(
    private readonly supplementAssemblyService: SupplementAssemblyService,
    private readonly fileService: SupplementAssemblyFileService,
  ) {}

  // ===================================================================
  // Sidebar Counts & History — Wave B placeholders
  // (MUST be BEFORE the parameterized `:supplementId` routes so they
  // do not get shadowed by NestJS path matching.)
  // ===================================================================

  /**
   * Sidebar badge count for `/local-plan-book/assembly/supplement`.
   *
   * Returns the number of ACTIONABLE supplements (head-of-lineage,
   * open, not booked) under the latest `DevelopmentPlan`. Mirrors the
   * `activeSupplements` membership rule in `SupplementAssemblyPage`
   * lines 78-97 / 167-174. Role-gated to admin + super-admin per the
   * page guard; other roles receive `{ actionable: 0 }` (HTTP 200) per
   * the §9 fallback-zero convention. §17.2 advisory-only — never gates
   * any workflow transition.
   *
   * Contract source: `docs/tasks/SUPPLEMENT_SIDEBAR_BADGES_BE_ASSEMBLY_COUNT.md` §7.
   *
   * NOTE: This route is declared BEFORE any parameterized supplement
   * route (`:supplementId/...`) so NestJS path matching cannot shadow
   * it (see the comment block above for the placement contract).
   */
  @Get('counts')
  async getAssemblyCounts(
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<{ actionable: number }> {
    const role = req.user?.role;
    this.logger.log(`Fetching supplement-assembly counts role=${role}`);
    const actionable =
      await this.supplementAssemblyService.getActionableCount(role);
    return { actionable };
  }

  /**
   * TODO(Wave B): wire to `SupplementAssemblyService.getAssemblyHistory`.
   * Returns an empty array placeholder.
   */
  @Get('history')
  async getAssemblyHistory(
    @Req() _req: Request & { user: JwtPayloadUser },
  ): Promise<unknown[]> {
    return [];
  }

  // ===================================================================
  // Display State / Readiness — Wave B placeholders
  // ===================================================================

  /**
   * TODO(Wave B): wire to `SupplementAssemblyService.getBookDisplayState`
   * once the service surface exists. Returns a minimal envelope so the
   * FE book-state hook can render a default state.
   */
  @Get(':supplementId/book-state')
  async getBookDisplayState(
    @Param('supplementId') supplementId: string,
    @Req() _req: Request & { user: JwtPayloadUser },
  ): Promise<{ supplementId: string; state: string }> {
    if (!supplementId) {
      throw new BadRequestException('supplementId จำเป็นต้องระบุ');
    }
    return { supplementId, state: 'unknown' };
  }

  /**
   * TODO(Wave B): wire to `SupplementAssemblyService.getReadiness` once
   * the service surface exists. Returns a default-not-ready envelope.
   */
  @Get(':supplementId/readiness')
  async getReadiness(
    @Param('supplementId') supplementId: string,
    @Req() _req: Request & { user: JwtPayloadUser },
  ): Promise<{ supplementId: string; ready: boolean }> {
    if (!supplementId) {
      throw new BadRequestException('supplementId จำเป็นต้องระบุ');
    }
    return { supplementId, ready: false };
  }

  // ===================================================================
  // Draft Management
  // ===================================================================

  @Post(':supplementId/draft')
  async createDraft(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Creating supplement-assembly draft for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.createDraft(supplementId, userId);
  }

  @Get(':supplementId/draft')
  async getActiveDraft(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.supplementAssemblyService.getActiveDraft(supplementId, userId);
  }

  @Delete(':supplementId/draft')
  async discardDraft(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Discarding supplement-assembly draft for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.discardDraft(supplementId, userId);
  }

  @Get(':supplementId/draft/canceled')
  async getCanceledDraft(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.supplementAssemblyService.getCanceledDraft(
      supplementId,
      userId,
    );
  }

  @Post(':supplementId/draft/restore')
  async restoreDraft(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Restoring supplement-assembly draft for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.restoreDraft(supplementId, userId);
  }

  @Delete(':supplementId/draft/canceled')
  async purgeCanceledDraft(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Purging canceled supplement-assembly draft for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.purgeCanceledDraft(
      supplementId,
      userId,
    );
  }

  // ===================================================================
  // Part Upload and Generation
  // ===================================================================

  @Post(':supplementId/draft/part-1')
  @UseInterceptors(FileInterceptor('file', pdfMulterConfig))
  async uploadPart1(
    @Param('supplementId') supplementId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException('กรุณาแนบไฟล์ PDF สำหรับส่วนที่ 1');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `Uploading supplement-assembly Part 1 for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.uploadPart1(
      supplementId,
      userId,
      file.buffer,
      file.originalname,
    );
  }

  @Post(':supplementId/draft/part-2')
  @UseInterceptors(FileInterceptor('file', pdfMulterConfig))
  async uploadPart2(
    @Param('supplementId') supplementId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException('กรุณาแนบไฟล์ PDF สำหรับส่วนที่ 2');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `Uploading supplement-assembly Part 2 for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.uploadPart2(
      supplementId,
      userId,
      file.buffer,
      file.originalname,
    );
  }

  @Post(':supplementId/draft/part-3/generate')
  async generatePart3(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Generating supplement-assembly Part 3 for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.generatePart3(supplementId, userId);
  }

  @Post(':supplementId/draft/part-:partNumber/reuse/:versionNumber')
  async reusePart(
    @Param('supplementId') supplementId: string,
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
    const userId = req.user?.userId;
    this.logger.log(
      `Reusing supplement Part ${partNumber} from v${versionNumber} for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.reusePart(
      supplementId,
      userId,
      partNumber,
      versionNumber,
    );
  }

  @Get(':supplementId/draft/parts/:partNumber')
  async viewDraftPart(
    @Param('supplementId') supplementId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (partNumber < 1 || partNumber > 3) {
      throw new BadRequestException('partNumber ต้องเป็น 1, 2 หรือ 3');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `View supplement draft part-${partNumber} for ${supplementId} by user ${userId}`,
    );

    const buffer = await this.supplementAssemblyService.viewDraftPart(
      supplementId,
      userId,
      partNumber,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="part-${partNumber}.pdf"`,
      'Content-Length': buffer.length.toString(),
    });
    res.end(buffer);
  }

  // ===================================================================
  // Preview and Merge
  // ===================================================================

  @Post(':supplementId/draft/preview')
  async preview(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Preview supplement-assembly for ${supplementId} by user ${userId}`,
    );
    const buffer = await this.supplementAssemblyService.preview(
      supplementId,
      userId,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="supplement-preview.pdf"',
    });
    res.end(buffer);
  }

  @Post(':supplementId/draft/merge')
  async merge(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Merging supplement-assembly for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.merge(supplementId, userId);
  }

  // ===================================================================
  // Version Management
  // ===================================================================

  @Get(':supplementId/versions')
  async getVersions(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.supplementAssemblyService.getVersions(supplementId, userId);
  }

  @Get(':supplementId/current')
  async getCurrentVersion(
    @Param('supplementId') supplementId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.supplementAssemblyService.getCurrentVersion(
      supplementId,
      userId,
    );
  }

  @Get(':supplementId/versions/:versionNumber')
  async getVersionByNumber(
    @Param('supplementId') supplementId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    return this.supplementAssemblyService.getVersionByNumber(
      supplementId,
      userId,
      versionNumber,
    );
  }

  // ===================================================================
  // Downloads
  // ===================================================================

  @Get(':supplementId/versions/:versionNumber/download')
  async downloadMerged(
    @Param('supplementId') supplementId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    if (versionNumber < 1) {
      throw new BadRequestException('versionNumber ต้องเป็นจำนวนเต็มบวก');
    }
    const userId = req.user?.userId;
    this.logger.log(
      `Download merged supplement v${versionNumber} for ${supplementId} by ${userId}`,
    );

    // Validate read access (404 path) — also resolves version row presence.
    await this.supplementAssemblyService.getVersionByNumber(
      supplementId,
      userId,
      versionNumber,
    );

    // Wave 3 BE-WRITERS — service-level helper resolves the stored
    // merged path (legacy abs OR new relative key) and validates it.
    const absPath = await this.supplementAssemblyService.getMergedAbsolutePath(
      supplementId,
      versionNumber,
    );
    this.fileService.assertPathWithinStorageRoot(absPath);
    const filename = `official-supplement-book-v${versionNumber}.pdf`;
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': stat.size.toString(),
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(
        `Stream error downloading merged supplement v${versionNumber}: ${err.message}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  @Get(':supplementId/versions/:versionNumber/parts/:partNumber')
  async downloadPart(
    @Param('supplementId') supplementId: string,
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
      `Download supplement part-${partNumber} v${versionNumber} for ${supplementId} by ${userId}`,
    );

    // Validate read access (404 path) — also resolves version row presence.
    await this.supplementAssemblyService.getVersionByNumber(
      supplementId,
      userId,
      versionNumber,
    );

    // Wave 3 BE-WRITERS — service-level helper recomputes the part key
    // from (location, version, partNumber) since SPG versions don't
    // persist per-part columns.
    const absPath = await this.supplementAssemblyService.getPartAbsolutePath(
      supplementId,
      versionNumber,
      partNumber,
    );
    this.fileService.assertPathWithinStorageRoot(absPath);
    const filename = `part-${partNumber}-v${versionNumber}.pdf`;
    const stat = fs.statSync(absPath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': stat.size.toString(),
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(
        `Stream error downloading supplement part-${partNumber} v${versionNumber}: ${err.message}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  // ===================================================================
  // Cancel (admin escape — Q4=C)
  // ===================================================================
  //
  // Mirrors `BookAssemblyController.cancel` shape but the supplement
  // service's cancel does NOT take a body — Q4=C Wave A scope keeps
  // cancel reasonless. The optional `reason` is accepted defensively
  // for forward-compat (Wave B) and currently ignored.

  @Post(':supplementId/cancel')
  async cancel(
    @Param('supplementId') supplementId: string,
    @Body() _body: { reason?: string } | undefined,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Cancel supplement-assembly for ${supplementId} by user ${userId}`,
    );
    return this.supplementAssemblyService.cancel(supplementId, userId);
  }
}
