import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { PhaseType, PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
} from 'src/common/project-classification/constants';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { GeoBoundaryService } from 'src/ai/geo-boundary.service';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import {
  assertWizardCompleteness,
  WizardCompletenessPayload,
} from '../util/wizard-completeness.util';
import { isAgencyWorkHistory } from '../util/agency-data.util';
import { BulkUploadRowDto } from './dto/bulk-upload-row.dto';
import { BulkUploadRequestDto } from './dto/bulk-upload-request.dto';
import {
  BulkSaveType,
  BulkUploadContext,
  BulkUploadRowContext,
} from './dto/bulk-upload-context.dto';
import {
  BulkUploadRowError,
  BulkUploadRowResult,
  BulkUploadValidationResult,
} from './dto/bulk-upload-validation-result.dto';

/**
 * W113-BE-VALIDATE — Bulk Upload Validator (CLAUDE.md §19)
 *
 * Read-only batch validator used by `POST /project-groups/bulk` and
 * `POST /project-groups/bulk/validate` (W113-BE-BATCH).
 *
 * Pipeline (per W113-BE-VALIDATE §3.5, executed in this exact order):
 *   1. Authority / scope          — `assertBatchPreconditions`
 *   2. Plan scope binding         — `assertBatchPreconditions`
 *   3. Format resolution (cached) — `assertBatchPreconditions`
 *   4. Classification shape       — `validateRow`
 *   5. Reference data lookups     — `validateRow`
 *   6. Wizard completeness        — `validateRow` (publish only)
 *   7. Duplicate title            — `validateRow` (intra-batch + DB)
 *   8. §13.5 geo soft warning     — `validateRow` (advisory)
 *
 * Hard rules:
 *   - This service NEVER writes to the database.
 *   - This service NEVER touches `tracking_status` or any `ai_*` table.
 *   - `validateRow` NEVER throws — it accumulates errors into the row
 *     result so a single bad row does not abort the batch.
 *   - `assertBatchPreconditions` MAY throw — batch-level guard failures
 *     reject the whole submit before any row is examined.
 */
@Injectable()
export class BulkUploadValidator {
  private readonly logger = new Logger(BulkUploadValidator.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly bookFormatResolver: BookFormatResolver,
    private readonly classificationValidator: ProjectClassificationValidator,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    private readonly geoBoundary: GeoBoundaryService,
    private readonly bookLockService: BookLockService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────

  /**
   * Top-level entry: run the full 8-step pipeline against every row in
   * the request DTO and return a structured `BulkUploadValidationResult`.
   *
   * Accepts an optional `EntityManager` so the caller (BE-BATCH commit
   * path) can run the validator inside the same transaction as the
   * insert phase. When omitted, falls back to `dataSource.manager` for
   * read-only lookups.
   *
   * Throws on batch-level precondition failures (auth, phase closed,
   * scope mismatch, plan not latest) — the caller converts these into
   * `422 BULK_PRECONDITION_FAILED` responses.
   */
  async validate(
    rows: BulkUploadRowDto[] | BulkUploadRequestDto,
    contextOrUserId:
      | { userId: string; developmentPlanId: string; saveType: BulkSaveType }
      | string,
    em?: EntityManager,
  ): Promise<BulkUploadValidationResult> {
    // Allow the prompt-frozen call shape `validate(rows, context, em)` and
    // also the request-DTO shape `validate(dto, userId, em)` so callers
    // have flexibility. Internally we always work with the pair below.
    let rowList: BulkUploadRowDto[];
    let userId: string;
    let developmentPlanId: string;
    let saveType: BulkSaveType;

    if (Array.isArray(rows)) {
      rowList = rows;
      if (typeof contextOrUserId === 'string') {
        throw new BadRequestException(
          'BulkUploadValidator.validate: when rows[] is supplied, the second argument must be a context object',
        );
      }
      userId = contextOrUserId.userId;
      developmentPlanId = contextOrUserId.developmentPlanId;
      saveType = contextOrUserId.saveType;
    } else {
      rowList = rows.rows;
      developmentPlanId = rows.developmentPlanId;
      saveType = rows.saveType;
      if (typeof contextOrUserId !== 'string') {
        throw new BadRequestException(
          'BulkUploadValidator.validate: when a request DTO is supplied, the second argument must be the caller userId string',
        );
      }
      userId = contextOrUserId;
    }

    const manager = em ?? this.dataSource.manager;

    const ctx = await this.assertBatchPreconditions(
      manager,
      userId,
      developmentPlanId,
      saveType,
    );

    // Pre-detect intra-batch duplicate titles (W113-BE-VALIDATE §9 R1):
    // a single Map walk so each row knows whether its title collides
    // with another row in the SAME submission. The row-level check
    // additionally hits the DB via `ensureNoDuplicateTitle` semantics.
    const titleCounts = new Map<string, number>();
    for (const row of rowList) {
      const t = (row.title ?? '').trim();
      if (!t) continue;
      titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    }

    const rowResults: BulkUploadRowResult[] = [];
    for (let i = 0; i < rowList.length; i++) {
      const row = rowList[i];
      const result = await this.validateRow(manager, row, {
        workHistory: ctx.workHistory,
        reportFormat: ctx.reportFormat,
        developmentPlanId: ctx.developmentPlanId,
        saveType: ctx.saveType,
      });
      // Tag intra-batch duplicates so both colliding rows are flagged
      // (DB unique check would only catch one of them at insert time).
      const trimmed = (row.title ?? '').trim();
      if (trimmed && (titleCounts.get(trimmed) ?? 0) > 1) {
        result.errors.push({
          code: 'DUPLICATE_TITLE_IN_BATCH',
          field: 'ชื่อโครงการ',
          message: 'ชื่อโครงการซ้ำกับแถวอื่นในไฟล์เดียวกัน',
          severity: 'error',
        });
        result.status = 'invalid';
      }
      // Default clientRowIndex falls back to the array position.
      if (result.clientRowIndex === null && row.clientRowIndex === undefined) {
        result.clientRowIndex = i;
      }
      rowResults.push(result);
    }

    const validRows = rowResults.filter((r) => r.status === 'valid');
    const warnings = rowResults.flatMap((r) =>
      r.errors.filter((e) => e.severity === 'warning'),
    );

    return {
      developmentPlanId: ctx.developmentPlanId,
      reportFormat: ctx.reportFormat,
      saveType: ctx.saveType,
      total: rowResults.length,
      validCount: validRows.length,
      invalidCount: rowResults.length - validRows.length,
      rows: rowResults,
      validRows,
      warnings,
    };
  }

  /**
   * Batch-level guards — run ONCE per submit. CLAUDE.md §4 / §4.2 / §8 / §16.3.
   *
   * Returns the resolved entities (workHistory, plan, format, matched
   * phase) so the caller can reuse them without re-querying.
   *
   * Throws (caller converts to 4xx):
   *   - `UnauthorizedException` — workStatus != approved (§2)
   *   - `ForbiddenException`   — phase mismatch (LAO→agency phase or vice versa, §4.2)
   *   - `BadRequestException`  — plan not latest, plan booked, no open phase (§8)
   *   - `NotFoundException`    — plan id does not resolve
   */
  async assertBatchPreconditions(
    manager: EntityManager,
    userId: string,
    developmentPlanId: string,
    saveType: BulkSaveType,
  ): Promise<BulkUploadContext> {
    // Step 1 — authentication, work history, workStatus.
    // Always runs regardless of saveType — even draft authors need a
    // valid approved work-history (§2).
    const workHistory = await this.workHistoryLookup.getCurrent(manager, userId);
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);

    // Step 2 — plan must exist (always). Format resolution downstream
    // depends on it, and ref-data lookups (strategy/tactic/plan/issue)
    // are scoped to this plan even on the draft path.
    const plan = await manager.findOne(DevelopmentPlan, {
      where: { id: developmentPlanId },
    });
    if (!plan) {
      throw new NotFoundException(
        `Development Plan ID not found: ${developmentPlanId}`,
      );
    }

    // Step 2 (publish-only) — §8 main-plan activation flag check.
    // DRAFT path intentionally skips these guards: drafts are personal
    // scratch state with no plan-book binding, mirroring the single-row
    // contract (project-groups.service.ts:756 only checks isLatest /
    // isBooked when promoting a draft → published, NOT when creating
    // the draft itself). The user's submit-time choice between draft
    // and publish must produce the same gating behavior in bulk mode.
    if (saveType === BulkSaveType.PUBLISH) {
      if (!plan.isLatest) {
        throw new BadRequestException({
          code: 'BULK_PRECONDITION_FAILED',
          reason: 'PLAN_NOT_LATEST',
          message: 'แผนพัฒนาฯ ที่ระบุไม่ใช่แผนปัจจุบัน',
        });
      }
      if (plan.isBooked) {
        throw new BadRequestException({
          code: 'BULK_PRECONDITION_FAILED',
          reason: 'PLAN_BOOKED',
          message: 'แผนพัฒนาฯ ถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้',
        });
      }

      // Step 2.5 — §15 book lineage immutability (publish only).
      // The flag check above is necessary but not sufficient — a plan
      // may still have a non-soft-deleted newer revision/supplement
      // that freezes the lineage per §15. Delegate to the canonical
      // detector so a frozen plan rejects the whole publish batch with
      // `409 BOOK_HAS_NEWER_REVISION`. Drafts skip this check too
      // because they are not entering the plan-book lineage yet.
      await this.bookLockService.assertEditable(
        developmentPlanId,
        'development_plan',
        manager,
      );
    }

    // Step 3 — format resolution (cached for the whole batch). Runs on
    // both paths because per-row §16.5 classification shape validation
    // needs the parent plan's `reportFormat` even for drafts.
    const reportFormat = await this.bookFormatResolver.resolveByPlan(
      developmentPlanId,
      manager,
    );

    // Step 4 (publish-only) — §4.2 same-org scope: phase must be open
    // AND match the requester's classification (LAO → LAO phase, agency
    // → agency phase). DRAFT skips because no plan submission is
    // happening yet; the requester's classification still applies on
    // the eventual publish promotion.
    const isAgency = isAgencyWorkHistory(workHistory);
    let matchedPhase: PlanPhase | null = null;
    if (saveType === BulkSaveType.PUBLISH) {
      const requiredPhaseType = isAgency ? PhaseType.AGENCY : PhaseType.LAO;
      matchedPhase = await manager.findOne(PlanPhase, {
        where: {
          developmentPlan: { id: developmentPlanId },
          phaseType: requiredPhaseType,
          isOpen: true,
        },
      });
      if (!matchedPhase) {
        const typeLabel = isAgency ? 'ส่วนราชการ (AGENCY)' : 'อปท. (LAO)';
        throw new BadRequestException({
          code: 'BULK_PRECONDITION_FAILED',
          reason: 'PHASE_CLOSED',
          message: `ระยะเวลายื่นโครงการสำหรับ ${typeLabel} ยังไม่เปิด หรือปิดแล้ว`,
        });
      }
    }

    return {
      workHistory,
      plan,
      reportFormat,
      matchedPhase, // null only on draft path; downstream consumers branch on saveType
      developmentPlanId,
      saveType,
    };
  }

  /**
   * Per-row validation — pure read-only logic. NEVER throws on row
   * failures; accumulates every error into a `BulkUploadRowResult`.
   *
   * The geo soft warning (§13.5) is added with `severity='warning'` and
   * does NOT flip the row to `invalid` — matches the §13 advisory
   * contract.
   */
  async validateRow(
    manager: EntityManager,
    row: BulkUploadRowDto,
    context: BulkUploadRowContext,
  ): Promise<BulkUploadRowResult> {
    const errors: BulkUploadRowError[] = [];
    const result: BulkUploadRowResult = {
      clientRowIndex:
        row.clientRowIndex !== undefined && row.clientRowIndex !== null
          ? row.clientRowIndex
          : null,
      status: 'valid',
      errors,
    };

    // Step 4 — Classification shape (§16.5).
    try {
      this.classificationValidator.validate(context.reportFormat, {
        strategyId: row.strategyId,
        tacticId: row.tacticId,
        planId: row.planId,
        developmentIssueId: row.developmentIssueId,
        indicator: row.indicator,
      });
    } catch (e) {
      errors.push(this.toRowError(e, ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH));
    }

    // Step 5 — Reference-data lookups. We only run these when the shape
    // gate passed, otherwise an ISSUE_BASED row with stray strategyId
    // would produce a misleading "Strategy not found" error.
    if (errors.length === 0) {
      await this.assertReferenceData(manager, row, context, errors);
    }

    // Step 6 — Wizard completeness (publish only — drafts may be partial).
    if (errors.length === 0 && context.saveType === BulkSaveType.PUBLISH) {
      try {
        const payload: WizardCompletenessPayload = {
          title: row.title,
          objective: row.objective,
          goal: row.goal,
          startLat: row.startLat ?? null,
          startLng: row.startLng ?? null,
          expected: row.expected,
          strategyId: row.strategyId,
          tacticId: row.tacticId,
          planId: row.planId,
          developmentIssueId: row.developmentIssueId,
          budget: row.budget?.map((b) => ({ quantity: b.quantity ?? null })) ?? null,
        };
        assertWizardCompleteness(payload);
      } catch (e) {
        errors.push(this.toRowError(e, 'VALIDATION_FAILED'));
      }
    }

    // Step 7 — Duplicate title against the DB (intra-batch dups are
    // attached separately by the caller after this method returns).
    // We use the same predicate as `ProjectGroupsService.ensureNoDuplicateTitle`:
    // a project with the same title + same WorkHistory creator + isDraft=false.
    if (errors.length === 0 && row.title && row.title.trim() !== '') {
      const existing = await manager.findOne(ProjectGroup, {
        where: {
          title: row.title,
          createdBy: { id: context.workHistory.id },
          isDraft: false,
        } as any,
      });
      if (existing) {
        errors.push({
          code: 'DUPLICATE_TITLE',
          field: 'ชื่อโครงการ',
          message: 'ชื่อโครงการดังกล่าวมีผู้ใช้แล้ว',
          severity: 'error',
        });
      }
    }

    // Step 8 — §13.5 LAO geo soft warning (advisory only, never blocks).
    const geoReason = this.computeGeoWarning(context.workHistory, row);
    if (geoReason) {
      result.geoWarning = { reason: geoReason };
      errors.push({
        code: 'GEO_OUT_OF_SCOPE',
        field: 'พิกัดโครงการ',
        message: geoReason,
        severity: 'warning',
      });
    }

    // Final status: any hard error flips to 'invalid'. Warnings alone
    // keep the row valid (advisory contract per §13 / §17.2).
    const hasHardError = errors.some((e) => e.severity === 'error');
    result.status = hasHardError ? 'invalid' : 'valid';

    return result;
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Reference-data lookups for the row. Populates `errors` in place. The
   * lookups are kept naive (one per row) for now — Wave 113 Risk R6
   * documents the N+1 mitigation as a future optimization (pre-load
   * distinct ids into a Map at batch start).
   */
  private async assertReferenceData(
    manager: EntityManager,
    row: BulkUploadRowDto,
    context: BulkUploadRowContext,
    errors: BulkUploadRowError[],
  ): Promise<void> {
    if (context.reportFormat === ReportFormat.STRATEGY_BASED) {
      // strategyId, tacticId, planId are guaranteed present by the shape
      // validator above — but guard defensively in case the upstream
      // contract drifts.
      if (row.strategyId) {
        const strategy = await manager.findOne(Strategy, {
          where: { id: row.strategyId },
        });
        if (!strategy) {
          errors.push({
            code: 'STRATEGY_NOT_FOUND',
            field: 'ยุทธศาสตร์',
            message: `ไม่พบยุทธศาสตร์ที่ระบุ (${row.strategyId})`,
            severity: 'error',
          });
        }
      }
      if (row.tacticId) {
        const tactic = await manager.findOne(Tactic, {
          where: { id: row.tacticId },
        });
        if (!tactic) {
          errors.push({
            code: 'TACTIC_NOT_FOUND',
            field: 'กลยุทธ์',
            message: `ไม่พบกลยุทธ์ที่ระบุ (${row.tacticId})`,
            severity: 'error',
          });
        }
      }
      if (row.planId) {
        const plan = await manager.findOne(Plan, { where: { id: row.planId } });
        if (!plan) {
          errors.push({
            code: 'PLAN_NOT_FOUND',
            field: 'แผนงาน',
            message: `ไม่พบแผนงานที่ระบุ (${row.planId})`,
            severity: 'error',
          });
        }
      }
      return;
    }

    if (context.reportFormat === ReportFormat.ISSUE_BASED) {
      if (row.developmentIssueId) {
        const issue = await manager
          .getRepository(DevelopmentIssue)
          .createQueryBuilder('i')
          .leftJoin('i.developmentPlan', 'plan')
          .where('i.id = :id', { id: row.developmentIssueId })
          .andWhere('i.deleted_at IS NULL')
          .addSelect('plan.id', 'plan_id_alias')
          .getOne();
        if (!issue) {
          errors.push({
            code: ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND,
            field: 'ประเด็นการพัฒนา',
            message: ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND,
            severity: 'error',
          });
          return;
        }
        // §16.6 — issue must belong to the SAME plan as the batch target.
        // Re-fetch with relation to be safe (the query above does not
        // hydrate the relation by default).
        const issueWithPlan = await manager.findOne(DevelopmentIssue, {
          where: { id: row.developmentIssueId },
          relations: ['developmentPlan'],
        });
        if (
          !issueWithPlan ||
          issueWithPlan.developmentPlan?.id !== context.developmentPlanId
        ) {
          errors.push({
            code: ERROR_CODES.DEVELOPMENT_ISSUE_PLAN_MISMATCH,
            field: 'ประเด็นการพัฒนา',
            message: ERROR_MESSAGES.DEVELOPMENT_ISSUE_PLAN_MISMATCH,
            severity: 'error',
          });
        }
      }
    }
  }

  /**
   * Compute the §13.5 advisory geo warning for the row WITHOUT depending
   * on `ProjectGroupsService.checkGeoWarning` (avoids importing the god
   * service into this validator). Mirrors the original implementation
   * verbatim.
   */
  private computeGeoWarning(
    workHistory: { amphoe?: { id?: string } | null; localAdministrativeOrganization?: { id?: string } | null },
    coords: {
      startLat?: number | null;
      startLng?: number | null;
      endLat?: number | null;
      endLng?: number | null;
    },
  ): string | null {
    // Agency users are exempt from §13 entirely.
    if (
      workHistory.amphoe?.id === '3001' &&
      workHistory.localAdministrativeOrganization?.id === '3001027'
    ) {
      return null;
    }
    const amphoeId = workHistory.amphoe?.id;
    if (!amphoeId) return null;

    const warnings: string[] = [];
    if (coords.startLat != null && coords.startLng != null) {
      const inside = this.geoBoundary.isPointInsideAmphoe(
        Number(coords.startLat),
        Number(coords.startLng),
        amphoeId,
      );
      if (inside === false) {
        warnings.push('พิกัดจุดเริ่มต้นอยู่นอกเขตอำเภอของคุณ');
      }
    }
    if (coords.endLat != null && coords.endLng != null) {
      const inside = this.geoBoundary.isPointInsideAmphoe(
        Number(coords.endLat),
        Number(coords.endLng),
        amphoeId,
      );
      if (inside === false) {
        warnings.push('พิกัดจุดสิ้นสุดอยู่นอกเขตอำเภอของคุณ');
      }
    }
    return warnings.length > 0 ? warnings.join(' และ ') : null;
  }

  /**
   * Convert an arbitrary thrown exception (BadRequest, ForbiddenException,
   * etc.) into a per-row error item without losing the original message.
   * Used by the shape and wizard-completeness gates which throw via the
   * shared validators.
   */
  private toRowError(e: unknown, fallbackCode: string): BulkUploadRowError {
    if (e instanceof HttpException) {
      const response = e.getResponse();
      if (typeof response === 'object' && response !== null) {
        const obj = response as Record<string, any>;
        const code =
          typeof obj.code === 'string'
            ? obj.code
            : this.extractCodeFromMessage(obj.message ?? e.message, fallbackCode);
        const message =
          typeof obj.message === 'string'
            ? obj.message
            : Array.isArray(obj.message)
              ? obj.message.join(', ')
              : e.message;
        return {
          code,
          message,
          severity: 'error',
        };
      }
      return {
        code: this.extractCodeFromMessage(e.message, fallbackCode),
        message: e.message,
        severity: 'error',
      };
    }
    return {
      code: fallbackCode,
      message: (e as Error)?.message ?? 'Unknown validation error',
      severity: 'error',
    };
  }

  /**
   * `ProjectClassificationValidator` throws `BadRequestException` whose
   * message is `"<CODE>: <thai message>"` — split off the code prefix so
   * the row error preserves the canonical machine code.
   */
  private extractCodeFromMessage(message: string, fallback: string): string {
    if (!message || typeof message !== 'string') return fallback;
    const colonIdx = message.indexOf(':');
    if (colonIdx <= 0) return fallback;
    const candidate = message.slice(0, colonIdx).trim();
    // Only treat as a code if it looks like SCREAMING_SNAKE_CASE.
    if (/^[A-Z][A-Z0-9_]*$/.test(candidate)) return candidate;
    return fallback;
  }
}
