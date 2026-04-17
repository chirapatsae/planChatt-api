import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AiPreSubmitSnapshot } from './entities/ai-pre-submit-snapshot.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { CreatePreSubmitSnapshotDto } from './dto/pre-submit-snapshot.dto';
import {
  AiScoreEnvelope,
  buildAiScoreEnvelope,
  scoreToBand,
} from './utils/ai-score-envelope';
import { computeSmartApproveContentHash } from './utils/content-hash';

/**
 * Allowed staff-lead roles per CLAUDE.md staff-lead definition.
 * Mirrors the set used in `AttachmentProjectGroupsController` and
 * `DevelopmentIssueService.assertStaffLead`.
 */
const STAFF_LEAD_ROLES = new Set([
  'staff',
  'admin',
  'super-admin',
  'super_admin',
]);

/**
 * RF5 — Persist user-side pre-submit AI score for staff read.
 *
 * This service implements CLAUDE.md §17.3 (audit separation, no FK to
 * project tables) and §17.4 (`snapshot-only` staleness policy — `isStale`
 * is ALWAYS false on the read side because the snapshot is a photograph
 * at submit time, not a live evaluation).
 *
 * Hard rules enforced here:
 *   - NEVER writes to the workflow audit table (§12 boundary).
 *   - NEVER mutates or touches `project_groups`, `revised_project_groups`,
 *     `supplement_project_groups`, or any `development_plan*` table.
 *   - Write path is OWNER-ONLY (`workHistory.id === project.createdBy.id`).
 *   - Read path is STAFF-LEAD-ONLY (`staff | admin | super-admin`).
 *   - Resubmit soft-deletes prior active row; it is NEVER hard-deleted.
 *   - `isStale: false` is forced on every read response.
 */
@Injectable()
export class PreSubmitSnapshotService {
  private readonly logger = new Logger(PreSubmitSnapshotService.name);

  constructor(
    @InjectRepository(AiPreSubmitSnapshot)
    private readonly snapshotRepo: Repository<AiPreSubmitSnapshot>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedRepo: Repository<RevisedProjectGroup>,
    @InjectRepository(SupplementProjectGroup)
    private readonly supplementRepo: Repository<SupplementProjectGroup>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    private readonly dataSource: DataSource,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // Owner-side write
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Persist a pre-submit AI snapshot for the caller's project.
   *
   * Validation order follows CLAUDE.md VALIDATION ORDER:
   *   1. user exists
   *   2. current WorkHistory
   *   3. workStatus = approved
   *   4. load target project
   *   5. ownership — project.createdBy.id === workHistory.id
   * (Steps 6+ workflow-scope checks are intentionally NOT applied here:
   *  snapshot write is an audit-style side-effect that does not advance
   *  workflow status; scope binding will be enforced by the owning
   *  wizard's own submit endpoint.)
   *
   * Idempotency: if the active snapshot's `content_hash` matches the
   * newly computed one, we return the existing row unchanged — no new
   * row is inserted.
   */
  async createSnapshot(
    userId: string,
    dto: CreatePreSubmitSnapshotDto,
  ): Promise<AiPreSubmitSnapshot> {
    const workHistory = await this.loadApprovedWorkHistory(userId);

    // §4 ownership — match against WorkHistory.id (never userId directly).
    const ownerWorkHistoryId = await this.loadOwnerWorkHistoryId(
      dto.targetKind,
      dto.targetId,
    );
    if (ownerWorkHistoryId !== workHistory.id) {
      throw new ForbiddenException(
        'เฉพาะเจ้าของโครงการเท่านั้นที่บันทึกคะแนนก่อนส่งได้',
      );
    }

    // Server-side hash computation — do NOT trust a client-supplied hash.
    const contentHash = computeSmartApproveContentHash({
      project: dto.project,
      classification: dto.classification,
      attachments: dto.attachments ?? [],
      justification: null,
    });

    // Branch on `dto.result` — null/undefined signals the "no-AI baseline"
    // audit path (task ADD_NO_AI_BASELINE_SNAPSHOT §7.2, CLAUDE.md §17.2
    // advisory-only + §17.4 snapshot-only). Baseline rows MUST NOT invoke
    // any AI service, MUST NOT deduct quota, and MUST NOT write to
    // `ai_usage_logs` — they are pure audit markers declaring that the
    // owner submitted WITHOUT running user-side AI pre-submit review.
    const isBaseline = dto.result == null;

    const overallScore =
      !isBaseline && typeof dto.result?.overallScore === 'number'
        ? Math.max(0, Math.min(100, Math.round(dto.result.overallScore)))
        : null;
    const band = overallScore === null ? null : scoreToBand(overallScore);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AiPreSubmitSnapshot);

      const existingActive = await repo.findOne({
        where: {
          targetKind: dto.targetKind,
          targetId: dto.targetId,
          deletedAt: IsNull(),
        },
      });

      // Wave 10 N1 — Smart Idempotency (endpoint-rank aware).
      //
      // Policy (see docs/tasks/FIX_RF5_SMART_IDEMPOTENCY.md §7 and
      // CLAUDE.md §17.4 upgrade-only clause):
      //   rank('pre-submit-review') = 2  (AI-result, richer)
      //   rank('no-ai-baseline')    = 1  (audit marker)
      //
      // - same content_hash                → idempotent short-circuit
      // - incoming rank < existing rank    → downgrade-skip (return existing)
      //     · specifically prevents a baseline submit from silently
      //       overwriting an existing AI-result row (Bug A, Wave 10).
      // - otherwise                        → soft-delete existing + insert new
      //
      // §17.5 — no auto-recompute; the decision is metadata-only.
      // §17.3 — no FK to project tables, no tracking_status write.
      // §12   — soft-delete history preserved when an actual replacement
      //         happens; downgrade-skip performs ZERO writes.
      const incomingEndpoint: AiPreSubmitSnapshot['endpoint'] = isBaseline
        ? 'no-ai-baseline'
        : 'pre-submit-review';
      const existingEndpointBefore: AiPreSubmitSnapshot['endpoint'] | null =
        existingActive?.endpoint ?? null;

      if (existingActive) {
        const sameHash = existingActive.contentHash === contentHash;
        const downgrade =
          this.endpointRank(incomingEndpoint) <
          this.endpointRank(existingActive.endpoint);

        if (sameHash) {
          this.logger.log(
            `[RF5 write] idempotent hit targetKind=${dto.targetKind} targetId=${dto.targetId} ` +
              `existingEndpoint=${existingActive.endpoint} incomingEndpoint=${incomingEndpoint} ` +
              `sameHash=true downgrade=${downgrade} ` +
              `contentHash=${contentHash.slice(0, 8)} workHistory=${workHistory.id}`,
          );
          return existingActive;
        }

        if (downgrade) {
          // Baseline MUST NOT overwrite AI-result (§17.4 upgrade-only).
          // Return existing row unchanged — NO soft-delete, NO insert.
          this.logger.log(
            `[RF5 write] downgrade-skip targetKind=${dto.targetKind} targetId=${dto.targetId} ` +
              `existingEndpoint=${existingActive.endpoint} incomingEndpoint=${incomingEndpoint} ` +
              `sameHash=false downgrade=true ` +
              `existingHash=${existingActive.contentHash.slice(0, 8)} incomingHash=${contentHash.slice(0, 8)} ` +
              `workHistory=${workHistory.id} ` +
              `— baseline MUST NOT overwrite AI-result (§17.4 upgrade-only policy)`,
          );
          return existingActive;
        }

        // Hash differs AND not a downgrade — soft-delete and replace.
        // Covers: same-endpoint hash drift (latest wins) and upgrade
        // path (baseline → AI-result). History preserved per §17.5.
        existingActive.deletedAt = new Date();
        await repo.save(existingActive);
        this.logger.log(
          `[RF5 write] soft-deleted prior targetKind=${dto.targetKind} targetId=${dto.targetId} ` +
            `existingEndpoint=${existingActive.endpoint} incomingEndpoint=${incomingEndpoint} ` +
            `existingHash=${existingActive.contentHash.slice(0, 8)} incomingHash=${contentHash.slice(0, 8)} ` +
            `workHistory=${workHistory.id}`,
        );
      }

      const now = new Date();

      const row = isBaseline
        ? repo.create({
            targetKind: dto.targetKind,
            targetId: dto.targetId,
            workflow: dto.workflow,
            submittedByWorkHistoryId: workHistory.id,
            computedByWorkHistoryId: workHistory.id,
            // Baseline sentinels — task §7.2.
            score0100: null,
            band: null,
            summaryText: null,
            suggestions: [],
            categories: {},
            resultJson: {
              noAiBaseline: true,
              reason: 'user_submitted_without_ai_review',
              submittedAt: now.toISOString(),
            },
            contentHash,
            model: 'none',
            // Discriminator for the baseline row — read-side envelope
            // exposes `endpoint` so FE can branch render (W7-C-FE).
            endpoint: 'no-ai-baseline',
            // §17.4 canonical — baseline inherits snapshot-only policy.
            // `isStale: false` is forced on every read.
            stalenessPolicy: 'snapshot-only',
            computedAt: now,
          })
        : repo.create({
            targetKind: dto.targetKind,
            targetId: dto.targetId,
            workflow: dto.workflow,
            submittedByWorkHistoryId: workHistory.id,
            computedByWorkHistoryId: workHistory.id,
            score0100: overallScore,
            band,
            summaryText:
              typeof dto.result?.rationale === 'string'
                ? dto.result.rationale
                : null,
            suggestions: Array.isArray(dto.result?.suggestions)
              ? (dto.result!.suggestions as unknown[])
              : [],
            categories:
              dto.result?.categories && typeof dto.result.categories === 'object'
                ? dto.result.categories
                : {},
            resultJson:
              (dto.result as unknown as Record<string, unknown>) ?? {},
            contentHash,
            model:
              typeof dto.result?.model === 'string' && dto.result.model
                ? dto.result.model
                : 'unknown',
            endpoint: 'pre-submit-review',
            // §17.4 canonical — RF5 is snapshot-only. `isStale: false`
            // forced on every read regardless of what ends up in this
            // column.
            stalenessPolicy: 'snapshot-only',
            computedAt: now,
          });

      const saved = await repo.save(row);
      this.logger.log(
        `[RF5 write] saved snapshot targetKind=${saved.targetKind} targetId=${saved.targetId} endpoint=${saved.endpoint} contentHash=${saved.contentHash.slice(0, 8)} score=${saved.score0100 ?? 'null'} suggestionsCount=${Array.isArray(saved.suggestions) ? saved.suggestions.length : 0} workHistory=${workHistory.id} existingEndpointBefore=${existingEndpointBefore ?? 'null'}`,
      );
      return saved;
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Staff-lead read
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Fetch the active snapshot for a target, returning the canonical
   * `AiScoreEnvelope` with `isStale: false` forced (§17.4 `snapshot-only`).
   *
   * Returns 404 when no active snapshot exists — callers (FE) treat 404
   * as "legacy project without snapshot" and render a subdued fallback.
   */
  async getActiveSnapshot(
    userId: string,
    targetKind: string,
    targetId: string,
  ): Promise<{
    snapshot: AiPreSubmitSnapshot;
    envelope: AiScoreEnvelope;
    result: Record<string, unknown>;
  }> {
    await this.assertStaffLead(userId);

    if (
      targetKind !== 'project-group' &&
      targetKind !== 'revised-project-group' &&
      targetKind !== 'supplement-project-group'
    ) {
      throw new NotFoundException('ไม่พบข้อมูล snapshot');
    }

    const snapshot = await this.snapshotRepo.findOne({
      where: {
        targetKind: targetKind as AiPreSubmitSnapshot['targetKind'],
        targetId,
        deletedAt: IsNull(),
      },
    });

    if (!snapshot) {
      // Diagnostic read-back (CLAUDE.md §17.5 — READ-ONLY; no hard delete,
      // no mutation). Detects whether a soft-deleted row exists for this
      // (targetKind, targetId) — distinguishes "never written" from
      // "soft-deleted" (which would indicate an unexpected overwrite race).
      const withDeletedProbe = await this.snapshotRepo.findOne({
        where: {
          targetKind: targetKind as AiPreSubmitSnapshot['targetKind'],
          targetId,
        },
        withDeleted: true,
      });
      this.logger.warn(
        `[RF5 read 404] no active snapshot targetKind=${targetKind} targetId=${targetId} workHistory=${userId} probeFound=${!!withDeletedProbe} probeDeletedAt=${withDeletedProbe?.deletedAt?.toISOString() ?? 'null'} probeEndpoint=${withDeletedProbe?.endpoint ?? 'n/a'} probeTargetIdInDb=${withDeletedProbe?.targetId ?? 'n/a'}`,
      );
      throw new NotFoundException('ไม่พบข้อมูลการตรวจก่อนส่งของโครงการนี้');
    }

    // §17.4: `isStale: false` is forced for snapshot-only policy. The
    // helper respects the policy — we pass `snapshot-only` and do NOT
    // pass a currentHash, so the envelope returns `isStale: false`.
    const envelope = buildAiScoreEnvelope({
      score: snapshot.score0100,
      band: snapshot.band,
      computedAt: snapshot.computedAt,
      contentHash: snapshot.contentHash,
      model: snapshot.model ?? 'unknown',
      endpoint: snapshot.endpoint,
      policy: 'snapshot-only',
    });

    this.logger.log(
      `[RF5 read 200] returning snapshot targetKind=${targetKind} targetId=${targetId} endpoint=${snapshot.endpoint} contentHash=${snapshot.contentHash.slice(0, 8)} score=${snapshot.score0100 ?? 'null'} workHistory=${userId}`,
    );
    return {
      snapshot,
      envelope,
      result: snapshot.resultJson ?? {},
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Owner-gated read (Wave 12 N2)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Owner-gated read for the active snapshot of a project.
   *
   * Unlike `getActiveSnapshot` (which is staff-lead-only via
   * `assertStaffLead`), this method verifies the caller is the OWNER of
   * the snapshot via `submitted_by_work_history_id === workHistory.id`
   * (§4 ownership source of truth). Returns 403 on mismatch, 404 on
   * missing.
   *
   * Used by the FE ReadyToSendPage "ตรวจสอบด้วย AI" modal to skip a
   * redundant OpenAI call when a prior snapshot exists (token savings).
   *
   * §17.2 advisory — cache-reuse is a read; no workflow gating.
   * §17.3 audit separation preserved — no writes, no FK introduced.
   * §17.4 snapshot-only policy preserved — `isStale: false` forced via
   *   `buildAiScoreEnvelope` with `policy: 'snapshot-only'`.
   * §17.5 no auto-recompute — caller explicitly invokes; no side effects.
   * §17.11 no role exemption — owner gate is a SIBLING to the staff-lead
   *   gate; it does NOT call `assertStaffLead` and does NOT grant any
   *   workflow authority.
   */
  async getOwnerSnapshot(
    userId: string,
    targetKind: string,
    targetId: string,
  ): Promise<{
    snapshot: AiPreSubmitSnapshot;
    envelope: AiScoreEnvelope;
    result: Record<string, unknown>;
  }> {
    const workHistory = await this.loadApprovedWorkHistory(userId);

    if (
      targetKind !== 'project-group' &&
      targetKind !== 'revised-project-group' &&
      targetKind !== 'supplement-project-group'
    ) {
      throw new NotFoundException('ไม่พบข้อมูล snapshot');
    }

    const snapshot = await this.snapshotRepo.findOne({
      where: {
        targetKind: targetKind as AiPreSubmitSnapshot['targetKind'],
        targetId,
        deletedAt: IsNull(),
      },
    });

    if (!snapshot) {
      this.logger.log(
        `[RF5 owner-read 404] no active snapshot targetKind=${targetKind} targetId=${targetId} workHistory=${workHistory.id}`,
      );
      throw new NotFoundException('ไม่พบข้อมูลการตรวจก่อนส่งของโครงการนี้');
    }

    // Owner gate — must match the WorkHistory that wrote the snapshot.
    // 403 (not 404) on non-owner — consistent authorization semantics
    // and prevents silent leak via existence probing.
    if (snapshot.submittedByWorkHistoryId !== workHistory.id) {
      this.logger.warn(
        `[RF5 owner-read 403] non-owner tried to read snapshot targetKind=${targetKind} targetId=${targetId} snapshotSubmitter=${snapshot.submittedByWorkHistoryId} caller=${workHistory.id}`,
      );
      throw new ForbiddenException(
        'เฉพาะเจ้าของโครงการเท่านั้นที่เรียกดูข้อมูลนี้ได้',
      );
    }

    // §17.4: `isStale: false` forced for snapshot-only — no currentHash
    // comparison; the envelope helper respects the policy.
    const envelope = buildAiScoreEnvelope({
      score: snapshot.score0100,
      band: snapshot.band,
      computedAt: snapshot.computedAt,
      contentHash: snapshot.contentHash,
      model: snapshot.model ?? 'unknown',
      endpoint: snapshot.endpoint,
      policy: 'snapshot-only',
    });

    this.logger.log(
      `[RF5 owner-read 200] returning snapshot targetKind=${targetKind} targetId=${targetId} endpoint=${snapshot.endpoint} contentHash=${snapshot.contentHash.slice(0, 8)} score=${snapshot.score0100 ?? 'null'} workHistory=${workHistory.id}`,
    );

    return {
      snapshot,
      envelope,
      result: snapshot.resultJson ?? {},
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Wave 10 N1 — endpoint rank for smart idempotency (§17.4 upgrade-only).
   *
   *   'pre-submit-review' → 2 (AI-result, richer)
   *   'no-ai-baseline'    → 1 (audit marker)
   *
   * Any other value is defensive-rejected; no current caller produces one.
   */
  private endpointRank(endpoint: string): number {
    if (endpoint === 'pre-submit-review') return 2;
    if (endpoint === 'no-ai-baseline') return 1;
    throw new BadRequestException('UNKNOWN_ENDPOINT');
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
    if (!roleName || !STAFF_LEAD_ROLES.has(roleName)) {
      throw new ForbiddenException(
        'เฉพาะเจ้าหน้าที่ (staff / admin / super-admin) เท่านั้นที่เรียกดูข้อมูลนี้ได้',
      );
    }
    return workHistory;
  }

  private async loadOwnerWorkHistoryId(
    targetKind: CreatePreSubmitSnapshotDto['targetKind'],
    targetId: string,
  ): Promise<string> {
    if (targetKind === 'project-group') {
      const row = await this.projectGroupRepo.findOne({
        where: { id: targetId },
        relations: ['createdBy'],
      });
      if (!row) throw new NotFoundException('ไม่พบโครงการ');
      const id = row.createdBy?.id;
      if (!id) {
        throw new ForbiddenException('โครงการนี้ไม่มีข้อมูลเจ้าของที่ถูกต้อง');
      }
      return id;
    }
    if (targetKind === 'revised-project-group') {
      const row = await this.revisedRepo.findOne({
        where: { id: targetId },
        relations: ['createdBy'],
      });
      if (!row) throw new NotFoundException('ไม่พบโครงการฉบับแก้ไข');
      const id = row.createdBy?.id;
      if (!id) {
        throw new ForbiddenException('โครงการนี้ไม่มีข้อมูลเจ้าของที่ถูกต้อง');
      }
      return id;
    }
    // supplement-project-group
    const row = await this.supplementRepo.findOne({
      where: { id: targetId },
      relations: ['createdBy'],
    });
    if (!row) throw new NotFoundException('ไม่พบโครงการในเล่มเพิ่มเติม');
    const id = row.createdBy?.id;
    if (!id) {
      throw new ForbiddenException('โครงการนี้ไม่มีข้อมูลเจ้าของที่ถูกต้อง');
    }
    return id;
  }
}
