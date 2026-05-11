import { BadRequestException } from '@nestjs/common';

/**
 * Wizard completeness payload — the union of fields the upload / AddProject
 * wizard must populate before submission. Mirrors the relevant subset of
 * `CreateProjectGroupDto` AND the bulk upload row DTO so the same util can
 * be reused by both the single-row publish path and the bulk publish path.
 *
 * `developmentIssueId` and the strategy triple are mutually exclusive per
 * §16.5; this util only checks "at least one classification supplied" and
 * defers shape correctness to `ProjectClassificationValidator`.
 */
export interface WizardCompletenessPayload {
  title?: string | null;
  objective?: string | null;
  goal?: string | null;
  startLat?: number | null;
  startLng?: number | null;
  expected?: string | null;
  strategyId?: string | null;
  tacticId?: string | null;
  planId?: string | null;
  developmentIssueId?: string | null;
  budget?: Array<{ quantity?: number | null }> | null;
}

/**
 * ADD_PROJECT_PREVENT_STEP_BYPASS — pure-function form of the wizard
 * completeness gate originally implemented as a private method on
 * `ProjectGroupsService`. Extracted so the bulk-upload validator can call
 * it without depending on the god-service.
 *
 * Throws `BadRequestException` with the structured `VALIDATION_FAILED`
 * payload when one or more wizard steps are incomplete. The Thai display
 * mapping lives in the frontend; the backend emits step keys only.
 *
 * Draft paths MUST NOT call this — drafts are allowed to be partial.
 */
export function assertWizardCompleteness(dto: WizardCompletenessPayload): void {
  const missingFields: string[] = [];

  // step2 — project details
  if (!dto.objective || dto.objective.trim() === '') missingFields.push('step2.objective');
  if (!dto.goal || dto.goal.trim() === '') missingFields.push('step2.goal');
  if (!dto.title || dto.title.trim() === '') missingFields.push('step2.title');

  // step1 — coordinates
  if (dto.startLat === undefined || dto.startLat === null) missingFields.push('step1.startLat');
  if (dto.startLng === undefined || dto.startLng === null) missingFields.push('step1.startLng');

  // step0 — classification (one shape required; ProjectClassificationValidator
  // enforces exactness)
  const hasStrategyTriple = !!dto.strategyId && !!dto.tacticId && !!dto.planId;
  const hasIssue = !!dto.developmentIssueId;
  if (!hasStrategyTriple && !hasIssue) missingFields.push('step0.classification');

  // step3 — budget non-empty + at least one positive quantity
  if (!Array.isArray(dto.budget) || dto.budget.length === 0) {
    missingFields.push('step3.budget');
  } else {
    const hasPositive = dto.budget.some(
      (b) => b && typeof b.quantity === 'number' && b.quantity > 0,
    );
    if (!hasPositive) missingFields.push('step3.budget');
  }

  // step4 — expected always required; indicator is shape-conditional and
  // handled by ProjectClassificationValidator.
  if (!dto.expected || dto.expected.trim() === '') missingFields.push('step4.expected');

  if (missingFields.length > 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Project submission is incomplete',
      missingFields,
    });
  }
}
