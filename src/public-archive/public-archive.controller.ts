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
  Inject,
  Logger,
  Param,
  ParseIntPipe,
  Query,
  Req,
  Res,
  forwardRef,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as fs from 'fs';

import { PublicEngagementService } from 'src/public-engagement/public-engagement.service';
import {
  PublicArchiveService,
  PublicBookSourceType,
  PublicPlanDto,
  PublicProjectDetailDto,
  PublicProjectSearchHit,
} from './public-archive.service';

@Controller({ path: 'public/plans', version: '1' })
export class PublicArchiveController {
  private readonly logger = new Logger(PublicArchiveController.name);

  constructor(
    private readonly publicArchiveService: PublicArchiveService,
    @Inject(forwardRef(() => PublicEngagementService))
    private readonly engagementService: PublicEngagementService,
  ) {}

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
    // `'supplement'` added in Wave public-archive-supplement BE-01.
    // Unknown values silently coerce to `'all'` (matches existing
    // behaviour for forward-compat with future filter values).
    const type =
      typeRaw === 'main' ||
      typeRaw === 'edit' ||
      typeRaw === 'change' ||
      typeRaw === 'supplement'
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
   * GET /v1/public/plans/projects/:sourceType/:projectId
   *
   * Returns a PII-redacted detail DTO for a single approved project
   * (ProjectGroup for `main_plan`, RevisedProjectGroup for `edit_revision`
   * / `change_revision`) whose parent plan has at least one COMPLETED
   * published book. Reuses the same eligibility predicate as
   * `searchProjects` via the shared `getPublishedPlanIds` helper.
   *
   * Anonymous: NO `@UseGuards`. Auth header (if present) is ignored.
   *
   * Uniform 404 on every ineligibility (project missing, soft-deleted,
   * not approved, parent plan not publicly published, sourceType vs id
   * mismatch). MUST NOT distinguish "exists but ineligible" from "does
   * not exist" — PDPA + enumeration defense.
   *
   * Route ordering: this MUST be declared BEFORE the parameterized
   * `:sourceType/:sourceId/v:versionNumber/pdf` route below so Express
   * matches `/projects/:sourceType/:projectId` literally and does NOT
   * capture `projects` as `:sourceType`. The route ordering convention
   * is already established by `projects/search` above.
   */
  @Get('projects/:sourceType/:projectId')
  async getProjectDetail(
    @Param('sourceType') sourceType: string,
    @Param('projectId') projectId: string,
  ): Promise<PublicProjectDetailDto> {
    if (
      sourceType !== 'main_plan' &&
      sourceType !== 'edit_revision' &&
      sourceType !== 'change_revision' &&
      sourceType !== 'supplement'
    ) {
      // sourceType validation is sharper than the eligibility 404 —
      // the parameter is a closed enum, not a UUID, so we return 400
      // (matches the existing PDF route's validation pattern).
      throw new BadRequestException('sourceType ไม่ถูกต้อง');
    }
    return this.publicArchiveService.getProjectDetail(
      sourceType as PublicBookSourceType,
      projectId,
    );
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
    @Param('sourceType') sourceType: string,
    @Param('sourceId') sourceId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (versionNumber < 1) {
      throw new BadRequestException('versionNumber ต้องเป็นจำนวนเต็มบวก');
    }
    // Closed enum — every public surface accepts the same four source
    // types. CLEANUP wave BE-02 (2026-05-26) replaces the legacy
    // `BookAssemblySourceType` literal lookups with raw string-literal
    // checks; the four standalone subsystems own the per-type tables.
    if (
      sourceType !== 'main_plan' &&
      sourceType !== 'edit_revision' &&
      sourceType !== 'change_revision' &&
      sourceType !== 'supplement'
    ) {
      throw new BadRequestException('sourceType ไม่ถูกต้อง');
    }
    const resolvedSourceType = sourceType as PublicBookSourceType;

    const absPath = await this.publicArchiveService.resolvePublicPdfPath(
      resolvedSourceType,
      sourceId,
      versionNumber,
    );
    this.logger.log(`[public] stream ${resolvedSourceType}/${sourceId} v${versionNumber}`);

    // Engagement counter increment — fired BEFORE streaming so that
    // even a connection-drop after `pipe()` still counts. Wrapped to
    // swallow any failure — analytics MUST NOT block the PDF stream.
    // PDPA: read deviceId from header `X-Engagement-Device-Id` OR query
    // param `?d=<uuid>`. UUID-shape validation is defensive — anything
    // malformed is treated as null.
    //
    // NOTE (Wave public-archive-supplement BE-01): supplement downloads
    // are streamed and audited via the same controller hook, but the
    // `recordDownload` engagement path does NOT yet roll up supplement
    // book-level downloads into the parent plan's `download_count`.
    // This matches task BE-01 §6.6 decision — supplement book-level
    // download counter is out of scope; per §5 the supplement download
    // counter parity with revisions (which also lack per-revision
    // download counters) is intentional. We skip `recordDownload` for
    // supplement to avoid emitting a download event with an unsupported
    // `sourceType`; the PDF stream itself remains unaffected.
    if (resolvedSourceType !== 'supplement') {
      const rawHeader = req.headers['x-engagement-device-id'];
      const rawQuery = (req.query?.['d'] as string | undefined) ?? undefined;
      const deviceCandidate = (
        Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
      ) || rawQuery || null;
      const deviceId =
        deviceCandidate && /^[0-9a-f-]{36}$/i.test(deviceCandidate)
          ? deviceCandidate
          : null;
      // CLEANUP wave BE-02 — `resolvedSourceType` is already typed
      // as `PublicBookSourceType` literal union; the legacy
      // `BookAssemblySourceType` enum lookup is no longer needed.
      // The outer `if (resolvedSourceType !== 'supplement')` guard
      // ensures we never pass `'supplement'` to `recordDownload`,
      // which only accepts the three BookAssembly source types.
      await this.engagementService.recordDownload({
        sourceType: resolvedSourceType as 'main_plan' | 'edit_revision' | 'change_revision',
        sourceId,
        versionNumber,
        deviceId,
      });
    }

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
