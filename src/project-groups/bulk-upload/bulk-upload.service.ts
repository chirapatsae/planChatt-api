import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, DeepPartial, EntityManager } from 'typeorm';

import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Status } from 'src/status/entities/status.entity';

import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { PreSubmitSnapshotService } from 'src/ai/pre-submit-snapshot.service';
import { CreatePreSubmitSnapshotDto } from 'src/ai/dto/pre-submit-snapshot.dto';

import { BulkUploadValidator } from './bulk-upload.validator';
import { getAgencyData } from '../util/agency-data.util';
import { BulkUploadRequestDto } from './dto/bulk-upload-request.dto';
import { BulkUploadRowDto } from './dto/bulk-upload-row.dto';
import {
  BulkSaveType,
  BulkUploadContext,
} from './dto/bulk-upload-context.dto';
import {
  BulkUploadRowError,
  BulkUploadRowResult,
  BulkUploadValidationResult,
} from './dto/bulk-upload-validation-result.dto';
import {
  BulkUploadCommitResult,
  InsertedRowPointer,
} from './dto/bulk-upload-response.dto';

/**
 * Canonical Status row id for "รอนำส่ง" (Ready). Matches the literal id
 * the existing single-row `ProjectGroupsService.create` writes — preserved
 * as a constant so the bulk path stays in lock-step if that literal
 * changes elsewhere. Used for DRAFT inserts only; PUBLISH inserts resolve
 * the `Pending` row by name from the `status` table (canonical §3 status
 * machine).
 */
const READY_STATUS_ID = '8219cd82-fa61-4292-bd0d-fa58b08507e1';

/**
 * W113-BE-BATCH — Bulk Upload Commit Service (CLAUDE.md §19).
 *
 * Orchestrates the two new endpoints:
 *
 *   POST /project-groups/bulk/validate — dry-run validate-only path.
 *   POST /project-groups/bulk          — commit path (writes inside one
 *                                        transaction).
 *
 * Pipeline summary (commit path):
 *
 *   1. `dataSource.transaction(em => …)`
 *      a. `validator.validate(rows, ctx, em)` — full BE-VALIDATE pipeline.
 *      b. PUBLISH atomicity guard — abort with `BULK_VALIDATION_FAILED`
 *         if ANY row reports `status === 'invalid'`.
 *      c. Per valid row → insert ProjectGroup + Budget + initial
 *         TrackingStatus (`Ready` for draft / `Pending` for publish).
 *         `staffRemark = 'bulk-run:<runId>'` for traceability per
 *         W113-DOC-CLAUDE-19 §19.13.
 *      d. Apply §5 / §7 responsibleAgency lifecycle via
 *         `getAgencyData(workHistory)` — agency auto-fills, LAO leaves null.
 *   2. **POST-COMMIT** (outside the transaction): per published row, fire
 *      `PreSubmitSnapshotService.createSnapshot(...)` with `result: null`
 *      to write the §17.4 `no-ai-baseline` snapshot row. Failures are
 *      logged and swallowed — advisory per §17.2 / §19.11; they MUST NOT
 *      undo the workflow commit.
 *   3. Build response — flat `inserted[]`, flat `errors[]`, mixed `rows[]`.
 *
 * Invariants:
 *   - Bulk path NEVER bypasses §12 (per-row TrackingStatus written).
 *   - Bulk path NEVER bypasses §16.5 classification shape (validator).
 *   - Bulk path NEVER bypasses §4.2 same-org scope (validator
 *     `assertBatchPreconditions`).
 *   - Bulk path NEVER writes to `ai_pre_submit_snapshots` directly —
 *     always via `PreSubmitSnapshotService` (§17.3 audit separation).
 *   - Bulk path NEVER mutates `responsibleAgency` for LAO-origin rows
 *     (§7.2). Auto-assign happens for agency rows only.
 */
@Injectable()
export class BulkUploadService {
  private readonly logger = new Logger(BulkUploadService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly validator: BulkUploadValidator,
    private readonly snapshotService: PreSubmitSnapshotService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Public — validate-only (no writes)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Dry-run validation. Used by the FE preview surface BEFORE commit.
   * Delegates entirely to `BulkUploadValidator.validate` and performs
   * zero writes. The returned shape is the validator's
   * `BulkUploadValidationResult` — controller maps this to a 200 response.
   *
   * Throws on batch-level precondition failures (auth, phase closed,
   * scope mismatch, plan not latest); the controller converts those to
   * the structured 4xx envelope.
   */
  async validate(
    dto: BulkUploadRequestDto,
    userId: string,
  ): Promise<BulkUploadValidationResult> {
    return this.validator.validate(dto.rows, {
      userId,
      developmentPlanId: dto.developmentPlanId,
      saveType: dto.saveType,
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Public — commit
  // ──────────────────────────────────────────────────────────────────

  /**
   * Commit a validated batch. Atomic for `saveType=PUBLISH`, best-effort
   * for `saveType=DRAFT` per §19.5.
   *
   * The `runId` is generated client-side here (not persisted to its own
   * table — that's deferred to Phase C). Every TrackingStatus row gets
   * `staffRemark = 'bulk-run:<runId>'` so the lineage of a single submit
   * can be reconstructed by query.
   */
  async commit(
    dto: BulkUploadRequestDto,
    userId: string,
  ): Promise<BulkUploadCommitResult> {
    const runId = randomUUID();

    // ── Run validator + writes inside ONE transaction ────────────────
    const txResult = await this.dataSource.transaction(async (em) => {
      // 1a. Resolve batch context ONCE (auth / phase / plan-not-latest /
      //     scope mismatch). Throws on failure.
      const ctx = await this.validator.assertBatchPreconditions(
        em,
        userId,
        dto.developmentPlanId,
        dto.saveType,
      );

      // 1b. Full BE-VALIDATE per-row pipeline. We delegate to the public
      //     `validate(...)` entry to keep the intra-batch duplicate-title
      //     pre-detection (Map walk) consistent with the validate-only
      //     endpoint. The validator re-runs `assertBatchPreconditions`
      //     internally — read-only and cheap because the second call hits
      //     the same transactional snapshot — but the duplicated work is
      //     trivial compared to N rows of FK lookups.
      const validation = await this.validator.validate(
        dto.rows,
        {
          userId,
          developmentPlanId: dto.developmentPlanId,
          saveType: dto.saveType,
        },
        em,
      );

      // 2. PUBLISH atomicity (§19.5). Any `invalid` row aborts the whole
      //    transaction. The structured payload mirrors W113-BE-BATCH §5
      //    so the FE preview can render per-row error state without a
      //    second round-trip.
      const hasInvalid = validation.rows.some((r) => r.status === 'invalid');
      if (dto.saveType === BulkSaveType.PUBLISH && hasInvalid) {
        throw new BadRequestException({
          code: 'BULK_VALIDATION_FAILED',
          message:
            'พบข้อผิดพลาดในแถวที่ส่งมา ไม่สามารถบันทึกแบบ Publish ได้ (atomic)',
          rows: validation.rows,
        });
      }

      // 3. Resolve `Pending` status row ONCE per batch (PUBLISH path).
      //    Looked up by canonical name per §3 W67 source-of-truth and the
      //    pattern already used by `TrackingStatusService.bulkSubmit`.
      let pendingStatusId: string | null = null;
      if (dto.saveType === BulkSaveType.PUBLISH) {
        const pendingStatus = await em.findOne(Status, {
          where: { name: 'Pending' },
        });
        if (!pendingStatus) {
          throw new NotFoundException(
            'ไม่พบสถานะ "Pending" ในระบบ ข้อมูลสถานะอาจไม่สมบูรณ์',
          );
        }
        pendingStatusId = pendingStatus.id;
      }

      // 4. Per-row insert. We walk `validation.rows` so the result list
      //    stays aligned with the validator's per-row output (status flips
      //    from `valid → inserted` here and from `valid → failed` on
      //    insert exceptions in the DRAFT path).
      const inserted: InsertedRowPointer[] = [];
      const finalRows: BulkUploadRowResult[] = [];

      for (let i = 0; i < dto.rows.length; i++) {
        const row = dto.rows[i];
        const rowResult = validation.rows[i];

        if (rowResult.status === 'invalid') {
          // DRAFT best-effort: skip invalid rows but keep them in `rows[]`
          // so the FE can show line-by-line errors. PUBLISH already threw.
          finalRows.push(rowResult);
          continue;
        }

        try {
          const projectGroupId = await this.insertRow(
            em,
            row,
            ctx,
            dto.saveType,
            runId,
            pendingStatusId,
          );
          inserted.push({
            clientRowIndex: rowResult.clientRowIndex,
            projectGroupId,
          });
          finalRows.push({
            ...rowResult,
            status: 'inserted',
            projectGroupId,
          });
        } catch (e) {
          if (dto.saveType === BulkSaveType.PUBLISH) {
            // Atomic publish — bubble out, the whole batch rolls back.
            throw e;
          }
          // Draft best-effort — capture the failure, keep going.
          const failed: BulkUploadRowResult = {
            ...rowResult,
            status: 'failed',
            errors: [
              ...rowResult.errors,
              this.toRowError(e),
            ],
          };
          finalRows.push(failed);
        }
      }

      return {
        validation,
        ctx,
        finalRows,
        inserted,
      };
    });

    // ── POST-COMMIT (outside transaction) ────────────────────────────
    // §17.4 / §19.11 — per inserted row, write the `no-ai-baseline`
    // snapshot. Advisory per §17.2 — failures here MUST NOT undo the
    // workflow commit. Errors are logged and swallowed so a flaky AI
    // module never blocks a successful upload.
    if (dto.saveType === BulkSaveType.PUBLISH) {
      await this.fireBaselineSnapshots(
        userId,
        dto,
        txResult.ctx,
        txResult.inserted,
        txResult.finalRows,
      );
    }

    // ── Build response ───────────────────────────────────────────────
    const errors = txResult.finalRows.flatMap((r) => r.errors);

    // Flat counters mirroring the FE `BulkUploadResponse` contract.
    // Kept in lock-step with the legacy nested `summary` object for the
    // overlapping metrics (totalRows / insertedCount / errorCount).
    const total = txResult.finalRows.length;
    const insertedCount = txResult.inserted.length;
    const invalidCount = txResult.finalRows.filter(
      (r) => r.status === 'invalid',
    ).length;
    const failedCount = txResult.finalRows.filter(
      (r) => r.status === 'failed',
    ).length;
    const validCount = txResult.finalRows.filter(
      (r) => r.status === 'valid' || r.status === 'inserted',
    ).length;

    const result: BulkUploadCommitResult = {
      runId,
      developmentPlanId: txResult.ctx.developmentPlanId,
      reportFormat: txResult.ctx.reportFormat,
      saveType: dto.saveType,
      mode:
        dto.saveType === BulkSaveType.PUBLISH
          ? 'commit-atomic'
          : 'commit-best-effort',
      total,
      validCount,
      invalidCount,
      insertedCount,
      failedCount,
      rows: txResult.finalRows,
      inserted: txResult.inserted,
      errors,
      summary: {
        totalRows: total,
        insertedCount,
        errorCount: invalidCount + failedCount,
      },
    };

    this.logger.log(
      `[BE-BATCH] runId=${runId} planId=${dto.developmentPlanId} saveType=${dto.saveType} ` +
        `total=${result.summary.totalRows} inserted=${result.summary.insertedCount} ` +
        `errors=${result.summary.errorCount} mode=${result.mode}`,
    );

    return result;
  }

  // ──────────────────────────────────────────────────────────────────
  // Private — per-row insert
  // ──────────────────────────────────────────────────────────────────

  /**
   * Insert one ProjectGroup + Budget rows + initial TrackingStatus, all
   * inside the caller's transaction. Mirrors the column shape produced by
   * `ProjectGroupsService.create` / `createDraft`. Reuses the shared
   * `getAgencyData` util so §5 / §7 are honored uniformly.
   *
   * Status decision:
   *   - DRAFT   → READY_STATUS_ID (`รอนำส่ง`) and `isDraft=true`.
   *   - PUBLISH → caller-supplied `pendingStatusId` (resolved by name) and
   *     `isDraft=false` — bulk publish lands directly at `Pending` per
   *     W113-PLAN-00 §3.3 / W113-BE-BATCH §8 acceptance.
   *
   * Returns the inserted ProjectGroup uuid.
   */
  private async insertRow(
    em: EntityManager,
    row: BulkUploadRowDto,
    ctx: BulkUploadContext,
    saveType: BulkSaveType,
    runId: string,
    pendingStatusId: string | null,
  ): Promise<string> {
    const isPublish = saveType === BulkSaveType.PUBLISH;
    const workHistory = ctx.workHistory;

    // §16.5 — clear the slot the row does NOT use so the DB CHECK
    // constraint (exactly-one-shape) accepts the insert. Empty-string
    // indicators are coerced to null so the `indicator <> ''` check
    // accepts ISSUE_BASED rows whose template column was blank.
    const classificationColumns =
      ctx.reportFormat === ReportFormat.ISSUE_BASED
        ? {
            strategy: null,
            tactic: null,
            plan: null,
            indicator: null,
            developmentIssue: { id: row.developmentIssueId } as DevelopmentIssue,
          }
        : {
            strategy: { id: row.strategyId } as Strategy,
            tactic: { id: row.tacticId } as Tactic,
            plan: { id: row.planId } as Plan,
            indicator:
              row.indicator && row.indicator.trim() !== ''
                ? row.indicator
                : null,
            developmentIssue: null,
          };

    // §5 / §7 — agency auto-fills `responsibleAgency`; LAO leaves it null.
    // The util also drops `originAgencyId` for the agency case (see
    // `agency-data.util.ts`); for LAO origin we mirror the single-row
    // `create()` behavior of populating `originAgencyId` from the
    // creator's localAdministrativeOrganization.
    const agencyData = getAgencyData(workHistory);

    const isAgencyOrigin =
      workHistory.amphoe?.id === '3001' &&
      workHistory.localAdministrativeOrganization?.id === '3001027';

    const groupPayload: DeepPartial<ProjectGroup> = {
      title: row.title,
      objective: row.objective ?? '',
      goal: row.goal ?? '',
      startLat: row.startLat ?? null,
      startLng: row.startLng ?? null,
      endLat: row.endLat ?? null,
      endLng: row.endLng ?? null,
      expected: row.expected ?? '',
      projectYear: row.projectYear,
      isBooked: false,
      isDraft: !isPublish,
      ...classificationColumns,
      developmentPlan: { id: ctx.developmentPlanId } as any,
      createdBy: workHistory,
      // For LAO origin: `originAgencyId` carries the creator's LAO id.
      // For agency origin: leave null (matches single-row `create()`).
      originAgencyId: isAgencyOrigin
        ? null
        : ({ id: workHistory.localAdministrativeOrganization!.id } as any),
      amphoe: { id: workHistory.amphoe!.id } as any,
      localAdministrativeOrganization: {
        id: workHistory.localAdministrativeOrganization!.id,
      } as any,
      ...(agencyData as DeepPartial<ProjectGroup>),
    };

    const group = em.create(ProjectGroup, groupPayload);
    const savedGroup = await em.save(group);

    // §12 — initial TrackingStatus per row (no batch-level shortcut).
    const statusId = isPublish ? pendingStatusId! : READY_STATUS_ID;
    const trackingStatus = em.create(TrackingStatus, {
      projectGroupId: { id: savedGroup.id } as ProjectGroup,
      statusId: { id: statusId } as Status,
      createdBy: workHistory,
      isLatest: true,
      // §19.13 / W113-DOC-CLAUDE-19 — runId stamped onto every audit row
      // produced by this batch. The `bulk-run:` prefix reserves the
      // `staffRemark` namespace so a future dedicated run-id table
      // (Phase C) can distinguish bulk-origin audit rows from staff
      // remarks added later.
      staffRemark: `bulk-run:${runId}`,
    });
    await em.save(trackingStatus);

    // Budget rows. Both publish and draft accept budgets; the validator's
    // `assertWizardCompleteness` already enforced "at least one positive
    // quantity" for the publish path, so we trust the input here.
    if (Array.isArray(row.budget) && row.budget.length > 0) {
      const budgets = row.budget.map((b) =>
        em.create(Budget, {
          projectGroupId: { id: savedGroup.id } as ProjectGroup,
          year: b.year,
          quantity: b.quantity ?? 0,
        }),
      );
      await em.save(budgets);
    }

    return savedGroup.id;
  }

  // ──────────────────────────────────────────────────────────────────
  // Private — POST-COMMIT baseline snapshot fan-out (§17.4 / §19.11)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Fire `PreSubmitSnapshotService.createSnapshot(...)` with `result=null`
   * for every successfully published row.
   *
   * Why post-commit (vs in-transaction):
   *   - Per executor instructions (W113-BE-BATCH dispatch), snapshot
   *     failures MUST NOT undo a successful workflow commit. The
   *     snapshot is advisory per §17.2; the canonical project insert +
   *     audit row is the integrity boundary.
   *   - This deviates from the BE-BATCH frozen-spec §7 "rollback if
   *     snapshot throws" language; the executor explicitly overrides
   *     that clause in the dispatch envelope. Recorded here so future
   *     readers understand the rationale.
   *
   * The snapshot service performs its own ownership check
   * (`workHistory.id === project.createdBy.id`) and writes through the
   * same Wave 10 endpoint-rank policy (§17.4). We pass `result: null` so
   * the service writes the `no-ai-baseline` audit row — never the
   * `pre-submit-review` row. Bulk upload does NOT run live AI per
   * W113-PLAN-00 §3.5.
   */
  private async fireBaselineSnapshots(
    userId: string,
    dto: BulkUploadRequestDto,
    ctx: BulkUploadContext,
    inserted: InsertedRowPointer[],
    finalRows: BulkUploadRowResult[],
  ): Promise<void> {
    if (inserted.length === 0) return;

    // Re-key finalRows by projectGroupId for fast row-payload lookup.
    const rowByProjectId = new Map<string, BulkUploadRowDto>();
    for (let i = 0; i < dto.rows.length; i++) {
      const r = finalRows[i];
      if (r.status === 'inserted' && r.projectGroupId) {
        rowByProjectId.set(r.projectGroupId, dto.rows[i]);
      }
    }

    for (const ptr of inserted) {
      const row = rowByProjectId.get(ptr.projectGroupId);
      if (!row) continue; // defensive — should never happen

      const snapshotDto: CreatePreSubmitSnapshotDto = {
        targetKind: 'project-group',
        targetId: ptr.projectGroupId,
        workflow: 'add',
        // Null `result` triggers the no-AI baseline path inside the
        // snapshot service (§17.4 snapshot-only baseline branch).
        result: null,
        project: {
          title: row.title ?? null,
          objective: row.objective ?? null,
          goal: row.goal ?? null,
          expected: row.expected ?? null,
          indicator: row.indicator ?? null,
          startLat: row.startLat ?? null,
          startLng: row.startLng ?? null,
          endLat: row.endLat ?? null,
          endLng: row.endLng ?? null,
          amphoeId: ctx.workHistory.amphoe?.id ?? null,
          localOrganizationId:
            ctx.workHistory.localAdministrativeOrganization?.id ?? null,
          budgets: Array.isArray(row.budget)
            ? row.budget.map((b) => ({
                year: b.year,
                quantity: b.quantity ?? 0,
              }))
            : [],
        },
        classification: {
          reportFormat:
            ctx.reportFormat === ReportFormat.ISSUE_BASED
              ? 'ISSUE_BASED'
              : 'STRATEGY_BASED',
          // Bulk path does not pre-resolve names; the hash uses ids only
          // by leaving names null. Smart-idempotency (§17.4 Wave 10)
          // operates on `(target_kind, target_id, content_hash)` and
          // bulk inserts always land on a fresh target id, so collision
          // is essentially impossible — null names are safe here.
          strategyName: null,
          tacticName: null,
          planName: null,
          developmentIssueName: null,
        },
        attachments: [],
      };

      try {
        await this.snapshotService.createSnapshot(userId, snapshotDto);
      } catch (e) {
        // Advisory per §17.2 — log and continue. The workflow commit
        // is already durable; a missing baseline can be backfilled by
        // the user later via the existing AI snapshot endpoints.
        this.logger.error(
          `[BE-BATCH] baseline snapshot failed projectGroupId=${ptr.projectGroupId} runId=swallowed err=${(e as Error)?.message ?? 'unknown'}`,
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Private — error normalization
  // ──────────────────────────────────────────────────────────────────

  private toRowError(e: unknown): BulkUploadRowError {
    if (e instanceof Error) {
      return {
        code: 'INSERT_FAILED',
        message: e.message,
        severity: 'error',
      };
    }
    return {
      code: 'INSERT_FAILED',
      message: 'Unknown insert error',
      severity: 'error',
    };
  }
}
