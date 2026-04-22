import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { AiStaffReviewRun } from './entities/ai-staff-review-run.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  AiResultTargetKind,
  AiScoreBand,
  AiScoreEnvelope,
  buildAiScoreEnvelope,
  scoreToBand,
} from './utils/ai-score-envelope';

/**
 * Wave 41 N2 — StaffReviewCacheService.
 *
 * Owns read / write access to `ai_staff_review_runs` for the new staff
 * AI review upgrade (pre-submit-style scored review with
 * STRATEGY_BASED + ISSUE_BASED branching).
 *
 * Cache policy (task WAVE41_N2 §3):
 *   - One shared active row per `(target_kind, target_id, content_hash)`
 *     (active ⇒ `deleted_at IS NULL`).
 *   - Same-hash incoming write → short-circuit, return existing row
 *     (idempotent; zero INSERT, zero soft-delete).
 *   - Drift (different hash) → soft-delete prior active row and INSERT
 *     a fresh row inside a single transaction.
 *   - `reviewerWorkHistoryId` stamps the reviewer who caused the write.
 *     In the cross-reviewer-reuse case, reviewer B reads reviewer A's
 *     cached row verbatim (no re-stamp on read).
 *
 * Staleness model (§17.4): ALL rows use `staleness_policy = 'strict'`.
 * `isStale` is computed against a caller-supplied `currentContentHash`
 * when present; defaults to the stored hash → `isStale: false`.
 *
 * Hard rules enforced here (CLAUDE.md):
 *   - §17.2 advisory-only — no workflow gating introduced.
 *   - §17.3 audit separation — `ai_staff_review_runs` has NO FK to
 *     project tables / work_histories. This service NEVER writes to
 *     `tracking_status`, NEVER writes to `ai_pre_submit_snapshots`.
 *   - §17.4 `strict` staleness policy — all rows inherit `strict`.
 *   - §17.5 no auto-recompute — caller explicitly invokes; service is
 *     pure storage.
 *   - §17.11 no role exemption — staff-lead gate is an integrity check,
 *     not a bypass lever.
 */
@Injectable()
export class StaffReviewCacheService {
  private readonly logger = new Logger(StaffReviewCacheService.name);

  /**
   * Staff-lead role allow-list. Matches the canonical set used by
   * `PreSubmitSnapshotService.assertStaffLead` and
   * `DevelopmentIssueService.assertStaffLead`.
   */
  private static readonly STAFF_LEAD_ROLES = new Set([
    'staff',
    'admin',
    'super-admin',
    'super_admin',
  ]);

  /** 64-char lowercase-hex SHA-256. Matches `content_hash` column. */
  private static readonly SHA256_HEX_RE = /^[0-9a-f]{64}$/;

  constructor(
    @InjectRepository(AiStaffReviewRun)
    private readonly runRepo: Repository<AiStaffReviewRun>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    private readonly dataSource: DataSource,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // Write — create / upsert run
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Persist a staff reviewer run.
   *
   * Contract:
   *   - Matches the active row for `(targetKind, targetId)`.
   *   - Identical `contentHash` ⇒ return existing row unchanged
   *     (idempotent, cross-reviewer reuse honored).
   *   - Different `contentHash` ⇒ soft-delete prior + INSERT new, inside
   *     a single transaction. The new row's `reviewerWorkHistoryId`
   *     reflects the NEW reviewer (per-row metadata); cross-reviewer
   *     audit chronology lives in `ai_usage_logs`.
   *
   * Role gating — the service is the AUTHORITATIVE gate and enforces
   * staff-lead via `assertStaffLead` (role IN {staff, admin, super-admin}
   * AND workStatus = 'approved'). Controller-level gating is a defense-
   * in-depth layer that fails fast BEFORE LLM quota is burned; the
   * service gate is what guarantees correctness (Wave 41 N8 P0 fix —
   * previously only workStatus was validated here, which allowed a
   * `user`-role caller with approved workStatus to write reviewer runs).
   */
  async createRun(
    reviewerUserId: string,
    dto: {
      targetKind: AiResultTargetKind;
      targetId: string;
      contentHash: string;
      endpoint: string;
      resultJson: Record<string, unknown>;
      score0100: number | null;
      band: AiScoreBand | null;
      model: string;
      computedAt?: Date;
    },
    manager?: EntityManager,
  ): Promise<AiStaffReviewRun> {
    const reviewer = await this.assertStaffLead(reviewerUserId);
    this.assertValidHash(dto.contentHash);
    this.assertTargetKind(dto.targetKind);

    const run = async (em: EntityManager): Promise<AiStaffReviewRun> => {
      const repo = em.getRepository(AiStaffReviewRun);

      const existingActive = await repo.findOne({
        where: {
          targetKind: dto.targetKind,
          targetId: dto.targetId,
          deletedAt: IsNull(),
        },
      });

      if (existingActive && existingActive.contentHash === dto.contentHash) {
        // §17.4 strict + cross-reviewer cache reuse: identical hash ⇒
        // return the existing row verbatim. `reviewerWorkHistoryId`
        // preserves the first reviewer's stamp by design.
        this.logger.log(
          `[staff-review cache] idempotent hit targetKind=${dto.targetKind} targetId=${dto.targetId} ` +
            `contentHash=${dto.contentHash.slice(0, 8)} ` +
            `existingReviewer=${existingActive.reviewerWorkHistoryId} newReviewer=${reviewer.id}`,
        );
        return existingActive;
      }

      if (existingActive) {
        // Drift — soft-delete prior row.
        existingActive.deletedAt = new Date();
        await repo.save(existingActive);
        this.logger.log(
          `[staff-review cache] drift soft-delete targetKind=${dto.targetKind} targetId=${dto.targetId} ` +
            `oldHash=${existingActive.contentHash.slice(0, 8)} newHash=${dto.contentHash.slice(0, 8)}`,
        );
      }

      const now = dto.computedAt ?? new Date();
      const row = repo.create({
        targetKind: dto.targetKind,
        targetId: dto.targetId,
        reviewerWorkHistoryId: reviewer.id,
        contentHash: dto.contentHash,
        endpoint: dto.endpoint,
        resultJson: dto.resultJson ?? {},
        score0100: dto.score0100,
        band: dto.band,
        model: dto.model || 'unknown',
        // §17.4 canonical — reviewer runs are live, NOT snapshot-only.
        stalenessPolicy: 'strict',
        computedAt: now,
      });

      const saved = await repo.save(row);
      this.logger.log(
        `[staff-review cache] inserted targetKind=${saved.targetKind} targetId=${saved.targetId} ` +
          `endpoint=${saved.endpoint} reviewer=${saved.reviewerWorkHistoryId} ` +
          `contentHash=${saved.contentHash.slice(0, 8)} score=${saved.score0100 ?? 'null'}`,
      );
      return saved;
    };

    if (manager) {
      return run(manager);
    }
    return this.dataSource.transaction((em) => run(em));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Read — staff-lead active-run lookup
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Fetch the active cached run for a target, returning a composed
   * envelope + the stored result payload.
   *
   * Returns `null` when no active row exists — controller translates to
   * HTTP 404.
   *
   * `currentContentHash` (optional) lets the caller flip `isStale` when
   * the live content hash drifts. Omit to default `isStale: false` (the
   * stored hash is compared against itself).
   *
   * Staff-lead gate enforced via `assertStaffLead`. Non staff-lead
   * callers (`user` role, missing role) → 403.
   */
  async getActiveRun(
    reviewerUserId: string,
    targetKind: AiResultTargetKind,
    targetId: string,
    currentContentHash?: string | null,
  ): Promise<{
    run: AiStaffReviewRun;
    envelope: AiScoreEnvelope;
    result: Record<string, unknown>;
  } | null> {
    await this.assertStaffLead(reviewerUserId);
    this.assertTargetKind(targetKind);

    const run = await this.runRepo.findOne({
      where: {
        targetKind,
        targetId,
        deletedAt: IsNull(),
      },
    });

    if (!run) {
      return null;
    }

    // §17.4 strict: isStale = (currentHash !== storedHash) when caller
    // provides `currentContentHash`. Otherwise no drift is reported.
    const envelope = buildAiScoreEnvelope({
      score: run.score0100,
      band: run.band ?? (run.score0100 !== null ? scoreToBand(run.score0100) : null),
      computedAt: run.computedAt,
      contentHash: run.contentHash,
      model: run.model ?? 'unknown',
      endpoint: run.endpoint,
      policy: 'strict',
      currentHash: currentContentHash ?? undefined,
    });

    return {
      run,
      envelope,
      result: run.resultJson ?? {},
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Pure helper — expose so controllers / prompt service can check drift
  // without loading the row twice.
  // ─────────────────────────────────────────────────────────────────────
  isStale(run: AiStaffReviewRun, currentContentHash: string): boolean {
    if (typeof currentContentHash !== 'string' || currentContentHash === '') {
      return false;
    }
    return run.contentHash !== currentContentHash;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public guard — exposed so controllers can fail fast on non staff-lead
  // callers BEFORE burning LLM quota (Wave 41 N8 P0 defense-in-depth).
  // Internally delegates to the same `assertStaffLead` used by `createRun`
  // and `getActiveRun`, so controller and service gates are byte-aligned.
  // ─────────────────────────────────────────────────────────────────────
  async assertStaffLeadCaller(userId: string): Promise<WorkHistory> {
    return this.assertStaffLead(userId);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────

  private assertValidHash(hash: string): void {
    if (typeof hash !== 'string' || !StaffReviewCacheService.SHA256_HEX_RE.test(hash)) {
      throw new BadRequestException('INVALID_CONTENT_HASH');
    }
  }

  private assertTargetKind(kind: AiResultTargetKind): void {
    if (
      kind !== 'project-group' &&
      kind !== 'revised-project-group' &&
      kind !== 'supplement-project-group'
    ) {
      throw new BadRequestException('INVALID_TARGET_KIND');
    }
  }

  private async loadApprovedWorkHistory(userId: string): Promise<WorkHistory> {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus', 'role', 'user'],
    });
    if (!workHistory) {
      throw new NotFoundException('ไม่พบข้อมูล WorkHistory ของผู้ใช้งาน');
    }
    if (workHistory.workStatus?.name?.toLowerCase() !== 'approved') {
      throw new ForbiddenException('สิทธิ์การใช้งานของคุณไม่ใช่ approved');
    }
    return workHistory;
  }

  private async assertStaffLead(userId: string): Promise<WorkHistory> {
    const workHistory = await this.loadApprovedWorkHistory(userId);
    const roleName = workHistory.role?.name?.toLowerCase();
    if (!roleName || !StaffReviewCacheService.STAFF_LEAD_ROLES.has(roleName)) {
      throw new ForbiddenException(
        'เฉพาะเจ้าหน้าที่ (staff / admin / super-admin) เท่านั้นที่เรียกดูข้อมูลนี้ได้',
      );
    }
    return workHistory;
  }
}
