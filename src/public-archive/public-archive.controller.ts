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
  ParseUUIDPipe,
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
  ProjectSearchFilters,
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
   * GET /v1/public/plans/projects/search?q=&page=&pageSize=
   *
   * Find approved (published-only) projects whose title contains q, across
   * PG + RPG + SPG, ordered by global `createdAt DESC`. Server-side
   * paginated — each call returns ONE page plus the global `total` for the
   * pager (perf: only the page window is fetched, never the whole table).
   * Empty q → recent published projects (the projects-page initial list);
   * a single character → empty.
   *
   * Route ordering: this MUST be declared BEFORE the parameterized
   * `:sourceType/:sourceId/v:versionNumber/pdf` route below so Express
   * matches `/projects/search` literally (otherwise `projects` would be
   * captured as `:sourceType`).
   */
  @Get('projects/search')
  async searchProjects(
    @Query('q') q?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('year') yearRaw?: string,
    @Query('amphoeId') amphoeId?: string,
    @Query('agencyId') agencyId?: string,
    @Query('planId') planId?: string,
    @Query('sourceType') sourceTypeRaw?: string,
    @Query('sort') sortRaw?: string,
  ): Promise<{
    items: PublicProjectSearchHit[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const trimmed = (q ?? '').trim();
    const pageSize = Math.min(50, Math.max(1, Number.parseInt(pageSizeRaw ?? '10', 10) || 10));
    const page = Math.max(0, Number.parseInt(pageRaw ?? '0', 10) || 0);
    // A single character is too noisy → return an empty page.
    if (trimmed.length === 1) return { items: [], total: 0, page, pageSize };

    const yearNum = Number.parseInt(yearRaw ?? '', 10);
    const sourceType = (['main', 'edit', 'change', 'supplement'] as const).find(
      (t) => t === sourceTypeRaw,
    );
    const sort = sortRaw === 'popular' ? 'popular' : undefined;
    const filters: ProjectSearchFilters = {
      year: Number.isFinite(yearNum) ? yearNum : undefined,
      amphoeId: amphoeId?.trim() || undefined,
      agencyId: agencyId?.trim() || undefined,
      planId: planId?.trim() || undefined,
      sourceType,
      sort,
    };

    const { items, total } = await this.publicArchiveService.searchProjectsPaged(
      trimmed,
      page,
      pageSize,
      filters,
    );
    return { items, total, page, pageSize };
  }

  /**
   * GET /v1/public/plans/projects/filter-options
   *
   * Years / amphoes / agencies that appear among published-only + Approved
   * projects — populates the public project-search filter dropdowns.
   * Anonymous, read-only. MUST be declared before the parameterized
   * `:sourceType/:projectId` route (same ordering rule as `projects/search`).
   */
  @Get('projects/filter-options')
  async getProjectFilterOptions(): Promise<{
    years: number[];
    amphoes: { id: string; name: string }[];
    agencies: { id: string; name: string }[];
    plans: { id: string; name: string }[];
  }> {
    return this.publicArchiveService.getProjectFilterOptions();
  }

  /**
   * GET /v1/public/plans/projects/map?planId=
   *
   * Public project map (แผนที่โครงการ) — the executive Amphoe > LAO > Project
   * aggregation, PUBLISHED-ONLY: only plans with a COMPLETED main book are
   * selectable and only `Approved` projects are shown. Anonymous, read-only.
   *
   * `planId` (optional UUID) must be a published plan, else the service 404s;
   * omitted → newest published plan. The response carries `availablePlans`
   * for the plan selector.
   *
   * Route ordering: declared BEFORE the parameterized
   * `:sourceType/:projectId` route so Express matches `/projects/map`
   * literally (same convention as `projects/search`).
   */
  @Get('projects/map')
  async getProjectMap(
    @Query('planId', new ParseUUIDPipe({ optional: true })) planId?: string,
  ): Promise<unknown> {
    return this.publicArchiveService.getProjectMap(planId);
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
    // Wave per-version-engagement-counts (2026-06-01): supplement
    // downloads are NOW recorded too — the prior public-archive-supplement
    // skip is removed so the public archive can show per-`<VersionRow>`
    // supplement download counts. `recordDownload` resolves the parent
    // plan for supplement via development_plan_supplement → plan and
    // still increments the plan-level `download_count`. Every source
    // type writes an `engagement_download_events` row carrying
    // `(source_type, source_id, version_number)` — already per-version.
    // recordDownload is internally try/caught — analytics never blocks
    // the PDF stream.
    {
      const rawHeader = req.headers['x-engagement-device-id'];
      const rawQuery = (req.query?.['d'] as string | undefined) ?? undefined;
      const deviceCandidate = (
        Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
      ) || rawQuery || null;
      const deviceId =
        deviceCandidate && /^[0-9a-f-]{36}$/i.test(deviceCandidate)
          ? deviceCandidate
          : null;
      await this.engagementService.recordDownload({
        sourceType: resolvedSourceType,
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
