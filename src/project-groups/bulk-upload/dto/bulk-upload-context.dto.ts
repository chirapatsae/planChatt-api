import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

/**
 * W113-BE-VALIDATE — saveType discriminator shared by the validator and
 * the future bulk commit service (W113-BE-BATCH). Re-exported as a value
 * (not just a type) so request DTOs can use `@IsEnum(BulkSaveType)`.
 */
export enum BulkSaveType {
  DRAFT = 'draft',
  PUBLISH = 'publish',
}

/**
 * Per-batch context resolved ONCE by `BulkUploadValidator.assertBatchPreconditions`
 * and then threaded through every per-row `validateRow` call.
 *
 * The context preserves the resolved entities so per-row validation does
 * not re-query the plan / phase / WorkHistory N times.
 */
export interface BulkUploadContext {
  workHistory: WorkHistory;
  plan: DevelopmentPlan;
  reportFormat: ReportFormat;
  /**
   * The open `PlanPhase` matching the requester's classification. Resolved
   * ONLY on the publish path — drafts intentionally skip the §4.2 phase
   * gate (mirroring the single-row contract where phase is checked at
   * publish-promote, not at draft-create). Consumers MUST guard on
   * `saveType` before dereferencing this field.
   */
  matchedPhase: PlanPhase | null;
  developmentPlanId: string;
  saveType: BulkSaveType;
}

/**
 * Subset of `BulkUploadContext` passed to `validateRow` — kept narrow on
 * purpose so per-row validation cannot accidentally mutate the resolved
 * batch entities (which would defeat the §10 plan-scope binding rule).
 */
export interface BulkUploadRowContext {
  workHistory: WorkHistory;
  reportFormat: ReportFormat;
  developmentPlanId: string;
  saveType: BulkSaveType;
}
