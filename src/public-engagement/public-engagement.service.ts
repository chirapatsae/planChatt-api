/**
 * Public Engagement Service.
 *
 * Backs three anonymous public surfaces:
 *   - project like (toggle, idempotent per device)
 *   - project / book view (debounced per device per day)
 *   - book download (append-only log + counter increment)
 *
 * Governance map:
 *   - CLAUDE.md §12 — engagement events MUST NOT create TrackingStatus
 *     rows. This service NEVER touches `tracking_status`.
 *   - CLAUDE.md §14 / §17.3 — engagement tables carry UUID `target_id`
 *     + discriminator without FK. Lineage rollback (§14.6) and orphan
 *     cleanup (§18) therefore cannot cascade into engagement history.
 *   - CLAUDE.md §17.2 — engagement counts are advisory; they MUST NOT
 *     gate any workflow transition.
 *
 * PDPA contract — explicitly NOT stored anywhere by this service:
 *   - IP address (used by guard, in memory only)
 *   - User-Agent (used by bot filter, in memory only)
 *   - Authenticated user identity (endpoints are anonymous)
 */

import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { PublicArchiveService } from 'src/public-archive/public-archive.service';

import { EngagementDownloadEvent } from './entities/engagement-download-event.entity';
import { EngagementLike } from './entities/engagement-like.entity';
import { EngagementViewEvent } from './entities/engagement-view-event.entity';

/**
 * Wave public-archive-supplement BE-01 widens both unions with
 * `'supplement_project_group'`. The `engagement_likes` /
 * `engagement_view_events` tables carry `target_kind` as `varchar(32)`
 * with NO foreign key (CLAUDE.md §17.3 audit-separation), so widening
 * is a TS-only change — no DB migration required for the engagement
 * event tables themselves. The denormalized `like_count` / `view_count`
 * columns on `supplement_project_groups` are added by the BE-01
 * companion migration.
 */
export type LikeTargetKind =
  | 'project_group'
  | 'revised_project_group'
  | 'supplement_project_group';
export type ViewTargetKind =
  | 'project_group'
  | 'revised_project_group'
  | 'supplement_project_group'
  | 'development_plan';
export type DownloadSourceType =
  | 'main_plan'
  | 'edit_revision'
  | 'change_revision'
  // Wave per-version-engagement-counts (2026-06-01) — supplement
  // downloads are now recorded so per-version supplement download
  // counts populate. The plan id is resolved via
  // development_plan_supplement → development_plan.
  | 'supplement';

/**
 * Book source type for VERSION-scoped view attribution. Wave
 * per-version-engagement-counts (2026-06-01). Distinct from the
 * `ViewTargetKind` denormalized-counter discriminator — this is the
 * assembled-book dimension written into the new
 * `engagement_view_events.source_type` column.
 */
export type ViewSourceType =
  | 'main_plan'
  | 'edit_revision'
  | 'change_revision'
  | 'supplement';

const BOT_UA_REGEX = /bot|crawler|spider|prerender|headless|preview/i;

@Injectable()
export class PublicEngagementService {
  private readonly logger = new Logger(PublicEngagementService.name);

  constructor(
    @InjectRepository(EngagementLike)
    private readonly likeRepo: Repository<EngagementLike>,
    @InjectRepository(EngagementViewEvent)
    private readonly viewRepo: Repository<EngagementViewEvent>,
    @InjectRepository(EngagementDownloadEvent)
    private readonly downloadRepo: Repository<EngagementDownloadEvent>,
    @InjectRepository(ProjectGroup)
    private readonly pgRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly rpgRepo: Repository<RevisedProjectGroup>,
    @InjectRepository(SupplementProjectGroup)
    private readonly spgRepo: Repository<SupplementProjectGroup>,
    @InjectRepository(DevelopmentPlan)
    private readonly planRepo: Repository<DevelopmentPlan>,
    @InjectRepository(DevelopmentPlanRevision)
    private readonly revisionRepo: Repository<DevelopmentPlanRevision>,
    // Wave per-version-engagement-counts — supplement download plan-id
    // resolution.
    @InjectRepository(DevelopmentPlanSupplement)
    private readonly supplementRepo: Repository<DevelopmentPlanSupplement>,
    @Inject(forwardRef(() => PublicArchiveService))
    private readonly publicArchive: PublicArchiveService,
    private readonly dataSource: DataSource,
  ) {}

  /* ── Helpers ─────────────────────────────────────────────────── */

  /** Compute today's date in Asia/Bangkok as `YYYY-MM-DD`. */
  private todayBangkok(): string {
    // `en-CA` gives ISO YYYY-MM-DD. timeZone option implements §7.3.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  private targetTableForLike(kind: LikeTargetKind): string {
    if (kind === 'project_group') return 'project_groups';
    if (kind === 'revised_project_group') return 'revised_project_groups';
    return 'supplement_project_groups';
  }

  private targetTableForView(kind: ViewTargetKind): string {
    if (kind === 'project_group') return 'project_groups';
    if (kind === 'revised_project_group') return 'revised_project_groups';
    if (kind === 'supplement_project_group') return 'supplement_project_groups';
    return 'development_plan';
  }

  /**
   * Reject obvious bot User-Agent strings. Stays in memory only —
   * NEVER persisted. Empty/missing UA is treated as bot (search-engine
   * fetchers often omit UA on JSON POSTs).
   */
  public isBotUserAgent(ua: string | undefined): boolean {
    if (!ua || ua.trim() === '') return true;
    return BOT_UA_REGEX.test(ua);
  }

  /**
   * Eligibility predicate.
   *
   * For `project_group` / `revised_project_group`: target must belong
   * to a plan that has at least one publicly-published main book.
   *
   * For `development_plan`: target must itself be in the published
   * set.
   *
   * Reuses `PublicArchiveService.getPublishedPlanIdsPublic()` so the
   * gate stays identical to the read surface.
   */
  private async assertEligible(
    kind: ViewTargetKind | LikeTargetKind,
    targetId: string,
  ): Promise<{ planId: string }> {
    const publishedPlanIds = await this.publicArchive.getPublishedPlanIdsPublic();
    if (publishedPlanIds.size === 0) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    if (kind === 'development_plan') {
      if (!publishedPlanIds.has(targetId)) {
        throw new NotFoundException('ไม่พบเล่มที่ระบุ');
      }
      return { planId: targetId };
    }

    if (kind === 'project_group') {
      const pg = await this.pgRepo
        .createQueryBuilder('pg')
        .leftJoinAndSelect('pg.developmentPlan', 'plan')
        .where('pg.id = :id', { id: targetId })
        .andWhere('pg.deletedAt IS NULL')
        .getOne();
      const planId = pg?.developmentPlan?.id;
      if (!planId || !publishedPlanIds.has(planId)) {
        throw new NotFoundException('ไม่พบโครงการที่ระบุ');
      }
      return { planId };
    }

    if (kind === 'supplement_project_group') {
      // SPG → plan via supplement. Eligibility chain: SPG must be
      // non-soft-deleted AND its parent supplement must be
      // non-soft-deleted AND the parent plan must be publicly
      // published. Failure collapses to uniform 404 — anonymous
      // callers cannot distinguish "exists but ineligible" from
      // "does not exist" (PDPA + enumeration defense).
      const spg = await this.spgRepo
        .createQueryBuilder('spg')
        .leftJoinAndSelect('spg.developmentPlanSupplement', 'sup')
        .leftJoinAndSelect('sup.developmentPlan', 'plan')
        .where('spg.id = :id', { id: targetId })
        .andWhere('spg.deletedAt IS NULL')
        .andWhere('sup.deleted_at IS NULL')
        .getOne();
      const planId = spg?.developmentPlanSupplement?.developmentPlan?.id;
      if (!planId || !publishedPlanIds.has(planId)) {
        throw new NotFoundException('ไม่พบโครงการที่ระบุ');
      }
      return { planId };
    }

    // revised_project_group → plan via revision
    const rpg = await this.rpgRepo
      .createQueryBuilder('rpg')
      .leftJoinAndSelect('rpg.developmentPlanRevision', 'rev')
      .leftJoinAndSelect('rev.developmentPlan', 'plan')
      .where('rpg.id = :id', { id: targetId })
      .andWhere('rpg.deletedAt IS NULL')
      .getOne();
    const planId = rpg?.developmentPlanRevision?.developmentPlan?.id;
    if (!planId || !publishedPlanIds.has(planId)) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }
    return { planId };
  }

  /* ── #1 Like toggle ──────────────────────────────────────────── */

  /**
   * Idempotent like toggle. One row per (target_kind, target_id,
   * device_id). Counter delta wrapped in the same SQL transaction as
   * the like-row mutation so reads are always consistent.
   *
   * Returns `{ liked, likeCount }` reflecting the post-state.
   */
  async toggleLike(input: {
    targetKind: LikeTargetKind;
    targetId: string;
    deviceId: string;
  }): Promise<{ liked: boolean; likeCount: number }> {
    await this.assertEligible(input.targetKind, input.targetId);

    const table = this.targetTableForLike(input.targetKind);

    return this.dataSource.transaction(async (em) => {
      const existing = await em
        .getRepository(EngagementLike)
        .createQueryBuilder('l')
        .where('l.targetKind = :k', { k: input.targetKind })
        .andWhere('l.targetId = :t', { t: input.targetId })
        .andWhere('l.deviceId = :d', { d: input.deviceId })
        .getOne();

      if (existing) {
        await em.getRepository(EngagementLike).delete(existing.id);
        // Atomic decrement, clamped to 0 to defend against drift.
        await em.query(
          `UPDATE "${table}" SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1`,
          [input.targetId],
        );
        const count = await this.readLikeCount(em, table, input.targetId);
        return { liked: false, likeCount: count };
      }

      const row = em.getRepository(EngagementLike).create({
        targetKind: input.targetKind,
        targetId: input.targetId,
        deviceId: input.deviceId,
      });
      await em.getRepository(EngagementLike).save(row);
      await em.query(
        `UPDATE "${table}" SET like_count = like_count + 1 WHERE id = $1`,
        [input.targetId],
      );
      const count = await this.readLikeCount(em, table, input.targetId);
      return { liked: true, likeCount: count };
    });
  }

  private async readLikeCount(
    em: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    table: string,
    id: string,
  ): Promise<number> {
    const rows = (await em.query(
      `SELECT like_count FROM "${table}" WHERE id = $1`,
      [id],
    )) as Array<{ like_count: number | string }>;
    if (!rows[0]) return 0;
    return Number(rows[0].like_count);
  }

  /* ── #2 View record ──────────────────────────────────────────── */

  /**
   * Debounced view. If a row already exists for
   * (target_kind, target_id, device_id, view_date), the counter is
   * NOT incremented and `{ debounced: true }` is returned.
   *
   * Bot User-Agent is filtered upstream by the controller (returns 204).
   * This service expects callers to have already filtered bots.
   */
  async recordView(input: {
    targetKind: ViewTargetKind;
    targetId: string;
    deviceId: string;
    // Wave per-version-engagement-counts — OPTIONAL book version
    // attribution. When present, written into the new
    // engagement_view_events columns so the public archive can roll up
    // per-`<VersionRow>` view counts. Absent → legacy behaviour
    // (version columns NULL).
    sourceType?: ViewSourceType;
    sourceId?: string;
    versionNumber?: number;
  }): Promise<{ viewCount: number; debounced: boolean }> {
    await this.assertEligible(input.targetKind, input.targetId);
    const table = this.targetTableForView(input.targetKind);
    const today = this.todayBangkok();

    // Only treat the view as version-scoped when the FULL triple is
    // present — a partial triple would create an inconsistent rollup
    // key, so we defensively fall back to plan-level NULLs.
    const hasVersion =
      input.sourceType != null &&
      input.sourceId != null &&
      input.versionNumber != null;
    const sourceType = hasVersion ? input.sourceType! : null;
    const sourceId = hasVersion ? input.sourceId! : null;
    const versionNumber = hasVersion ? input.versionNumber! : null;

    return this.dataSource.transaction(async (em) => {
      // ON CONFLICT arbitrates against the COALESCE-based expression
      // unique index `uq_engagement_views_target_ver_device_day`
      // (migration 1781200000000). The expression list MUST match the
      // index definition byte-for-byte so Postgres recognises it as the
      // conflict arbiter. COALESCing the nullable version columns to
      // sentinels collapses every NULL-version (legacy / project-level)
      // row to a single arbiter value, preserving the legacy
      // once-per-(target,device,day) debounce while distinguishing
      // distinct version-scoped rows.
      const insertResult = (await em.query(
        `INSERT INTO engagement_view_events
           (target_kind, target_id, source_type, source_id, version_number, device_id, view_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (
           target_kind,
           target_id,
           COALESCE(source_type, ''),
           COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid),
           COALESCE(version_number, -1),
           device_id,
           view_date
         )
         DO NOTHING
         RETURNING id`,
        [
          input.targetKind,
          input.targetId,
          sourceType,
          sourceId,
          versionNumber,
          input.deviceId,
          today,
        ],
      )) as Array<{ id: string }>;

      const inserted = insertResult.length > 0;
      if (inserted) {
        await em.query(
          `UPDATE "${table}" SET view_count = view_count + 1 WHERE id = $1`,
          [input.targetId],
        );
      }
      const count = await this.readViewCount(em, table, input.targetId);
      return { viewCount: count, debounced: !inserted };
    });
  }

  private async readViewCount(
    em: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    table: string,
    id: string,
  ): Promise<number> {
    const rows = (await em.query(
      `SELECT view_count FROM "${table}" WHERE id = $1`,
      [id],
    )) as Array<{ view_count: number | string }>;
    if (!rows[0]) return 0;
    return Number(rows[0].view_count);
  }

  /* ── #3 Download record ──────────────────────────────────────── */

  /**
   * Append-only download log. Increments `development_plan.download_count`
   * inside the same SQL transaction. Failure is logged but NEVER
   * propagated — the PDF stream must not be blocked by analytics.
   *
   * Resolves `development_plan_id` from `sourceType + sourceId`:
   *   - main_plan       → sourceId IS the plan id
   *   - edit_revision   → JOIN through development_plan_revision
   *   - change_revision → JOIN through development_plan_revision
   *   - supplement      → JOIN through development_plan_supplement
   *                       (Wave per-version-engagement-counts)
   */
  async recordDownload(input: {
    sourceType: DownloadSourceType;
    sourceId: string;
    versionNumber: number;
    deviceId: string | null;
  }): Promise<void> {
    try {
      let planId: string | null = null;
      if (input.sourceType === 'main_plan') {
        const plan = await this.planRepo.findOne({
          where: { id: input.sourceId },
          select: { id: true },
        });
        planId = plan?.id ?? null;
      } else if (input.sourceType === 'supplement') {
        // Supplement → plan via development_plan_supplement.
        const sup = await this.supplementRepo
          .createQueryBuilder('sup')
          .leftJoinAndSelect('sup.developmentPlan', 'plan')
          .where('sup.id = :id', { id: input.sourceId })
          .getOne();
        planId = sup?.developmentPlan?.id ?? null;
      } else {
        const rev = await this.revisionRepo
          .createQueryBuilder('rev')
          .leftJoinAndSelect('rev.developmentPlan', 'plan')
          .where('rev.id = :id', { id: input.sourceId })
          .getOne();
        planId = rev?.developmentPlan?.id ?? null;
      }

      if (!planId) {
        this.logger.warn(
          `[engagement] recordDownload could not resolve plan for ${input.sourceType}/${input.sourceId}`,
        );
        return;
      }

      await this.dataSource.transaction(async (em) => {
        const row = em.getRepository(EngagementDownloadEvent).create({
          developmentPlanId: planId as string,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          versionNumber: input.versionNumber,
          deviceId: input.deviceId,
        });
        await em.getRepository(EngagementDownloadEvent).save(row);
        await em.query(
          `UPDATE development_plan SET download_count = download_count + 1 WHERE id = $1`,
          [planId],
        );
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Per task spec — counter failure MUST NOT abort the PDF stream.
      this.logger.warn(`[engagement] recordDownload failed: ${msg}`);
    }
  }

  /* ── #4 Convenience read (used by DTO enrichment) ────────────── */

  /**
   * Read both engagement counts off the denormalized columns. The
   * caller already knows the type discriminator, so this is a cheap
   * single-row read.
   */
  async getProjectCounts(
    kind:
      | 'project_group'
      | 'revised_project_group'
      | 'supplement_project_group',
    id: string,
  ): Promise<{ likeCount: number; viewCount: number }> {
    const table = this.targetTableForLike(kind);
    const rows = (await this.dataSource.query(
      `SELECT like_count, view_count FROM "${table}" WHERE id = $1`,
      [id],
    )) as Array<{ like_count: number | string; view_count: number | string }>;
    if (!rows[0]) return { likeCount: 0, viewCount: 0 };
    return {
      likeCount: Number(rows[0].like_count),
      viewCount: Number(rows[0].view_count),
    };
  }

  async getPlanCounts(
    id: string,
  ): Promise<{ viewCount: number; downloadCount: number }> {
    const rows = (await this.dataSource.query(
      `SELECT view_count, download_count FROM development_plan WHERE id = $1`,
      [id],
    )) as Array<{ view_count: number | string; download_count: number | string }>;
    if (!rows[0]) return { viewCount: 0, downloadCount: 0 };
    return {
      viewCount: Number(rows[0].view_count),
      downloadCount: Number(rows[0].download_count),
    };
  }

}
