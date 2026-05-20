/**
 * Public Archive Controller.
 *
 * Exposes the assembled development plan archive without authentication.
 * Routes are intentionally NOT decorated with `@UseGuards(JwtAuthGuard)`
 * so anonymous citizens can browse + download published plan books.
 *
 * Defenses:
 *   - Service layer filters to `status = COMPLETED` only — drafts and
 *     deprecated versions are never exposed.
 *   - PII is stripped at the DTO layer (no creator names / IDs).
 *   - Read-only — no POST / PATCH / DELETE on this surface.
 *   - PDF stream sets long-lived Cache-Control because COMPLETED book
 *     versions are immutable. Browser + CDN can safely cache.
 */

import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';

import { BookAssemblySourceType } from 'src/book-assembly/enums/book-assembly.enums';
import {
  PublicArchiveService,
  PublicPlanDto,
  PublicProjectSearchHit,
} from './public-archive.service';

@Controller({ path: 'public/plans', version: '1' })
export class PublicArchiveController {
  private readonly logger = new Logger(PublicArchiveController.name);

  constructor(private readonly publicArchiveService: PublicArchiveService) {}

  /**
   * GET /v1/public/plans
   *
   * Query params:
   *   - q       — book name keyword (case-insensitive contains)
   *   - year    — single fiscal year that must fall within plan range
   *   - type    — 'main' | 'edit' | 'change' | 'all' (default 'all')
   */
  @Get()
  async list(
    @Query('q') q?: string,
    @Query('year') yearRaw?: string,
    @Query('type') typeRaw?: string,
  ): Promise<PublicPlanDto[]> {
    let year: number | undefined;
    if (yearRaw !== undefined && yearRaw !== '') {
      const parsed = Number(yearRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new BadRequestException('year ต้องเป็นจำนวนเต็ม');
      }
      year = parsed;
    }
    const type =
      typeRaw === 'main' || typeRaw === 'edit' || typeRaw === 'change'
        ? typeRaw
        : 'all';
    return this.publicArchiveService.listPlans({ q, year, type });
  }

  /**
   * GET /v1/public/plans/projects/search?q=...
   *
   * Find approved projects whose title contains q. Returns up to 50
   * combined hits across PG + RPG, each pointing at the parent plan +
   * book.
   *
   * Route ordering: this MUST be declared BEFORE the parameterized
   * `:sourceType/:sourceId/v:versionNumber/pdf` route below so Express
   * matches `/projects/search` literally (otherwise `projects` would be
   * captured as `:sourceType`).
   */
  @Get('projects/search')
  async searchProjects(@Query('q') q?: string): Promise<PublicProjectSearchHit[]> {
    if (!q || q.trim().length < 2) return [];
    return this.publicArchiveService.searchProjects(q, 50);
  }

  /**
   * GET /v1/public/plans/:sourceType/:sourceId/v:versionNumber/pdf
   *
   * Streams the merged PDF for a COMPLETED book version. Drafts and
   * deprecated versions return 404 (uniform "ไม่พบเล่มที่ระบุ") so the
   * existence of an unpublished file is never leaked via URL guessing.
   *
   * Cache header: COMPLETED versions are immutable (a corrected version
   * creates a NEW versionNumber), so we set
   *   `Cache-Control: public, max-age=86400, immutable`
   * which lets browsers + edge caches store the file for 24 hours.
   */
  @Get(':sourceType/:sourceId/v:versionNumber/pdf')
  async downloadPdf(
    @Param('sourceType') sourceType: BookAssemblySourceType,
    @Param('sourceId') sourceId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Res() res: Response,
  ): Promise<void> {
    if (versionNumber < 1) {
      throw new BadRequestException('versionNumber ต้องเป็นจำนวนเต็มบวก');
    }
    if (
      sourceType !== BookAssemblySourceType.MAIN_PLAN &&
      sourceType !== BookAssemblySourceType.EDIT_REVISION &&
      sourceType !== BookAssemblySourceType.CHANGE_REVISION
    ) {
      throw new BadRequestException('sourceType ไม่ถูกต้อง');
    }

    const absPath = await this.publicArchiveService.resolvePublicPdfPath(
      sourceType,
      sourceId,
      versionNumber,
    );
    this.logger.log(`[public] stream ${sourceType}/${sourceId} v${versionNumber}`);

    const stat = fs.statSync(absPath);
    const filename = `local-development-plan-v${versionNumber}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      // `inline` so the browser previews the PDF instead of forcing a
      // download — public users typically want to read on screen first.
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': stat.size.toString(),
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      this.logger.error(
        `[public] stream error ${sourceType}/${sourceId} v${versionNumber}: ${err.message}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }
}
