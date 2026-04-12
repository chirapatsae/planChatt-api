import { BadRequestException, Injectable } from '@nestjs/common';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { ERROR_CODES, ERROR_MESSAGES } from './constants';

/**
 * Payload shape accepted by the classification validator. Fields mirror
 * the union of classification slots on every project DTO
 * (ProjectGroup / RevisedProjectGroup / SupplementProjectGroup) — the
 * validator is format-aware and checks each slot against the §16.5
 * exactly-one-shape invariant.
 *
 * Empty-string `indicator` is coerced to `null` by `normaliseIndicator`
 * below so callers do not have to pre-sanitise the payload, matching
 * the DB CHECK rule `indicator <> ''` for STRATEGY_BASED.
 */
export interface ClassificationPayload {
  strategyId?: string | null;
  tacticId?: string | null;
  planId?: string | null;
  developmentIssueId?: string | null;
  indicator?: string | null;
}

/**
 * ProjectClassificationValidator — CLAUDE.md §16.5
 *
 * Side-effect-free, stateless, non-async validator. Called by every
 * project create/update path BEFORE the repository write so that no
 * mixed-shape row ever reaches the database.
 *
 * The validator does NOT verify that the supplied `developmentIssueId`
 * belongs to the same plan as the project. That is a service-layer
 * concern (the project service owns the plan-chain lookup and can
 * reject with `DEVELOPMENT_ISSUE_PLAN_MISMATCH` separately).
 */
@Injectable()
export class ProjectClassificationValidator {
  validate(format: ReportFormat, payload: ClassificationPayload): void {
    const normalised = this.normalise(payload);

    if (format === ReportFormat.STRATEGY_BASED) {
      this.assertStrategyBasedShape(normalised);
      return;
    }

    if (format === ReportFormat.ISSUE_BASED) {
      this.assertIssueBasedShape(normalised);
      return;
    }

    // Exhaustiveness guard — adding a new format without updating this
    // switch is a compile-time error because ReportFormat is a string
    // enum. Runtime throw here is a defensive safety net.
    throw new BadRequestException(
      `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: unknown format`,
    );
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  private normalise(payload: ClassificationPayload): ClassificationPayload {
    return {
      strategyId: this.emptyToNull(payload.strategyId),
      tacticId: this.emptyToNull(payload.tacticId),
      planId: this.emptyToNull(payload.planId),
      developmentIssueId: this.emptyToNull(payload.developmentIssueId),
      indicator: this.emptyToNull(payload.indicator),
    };
  }

  private emptyToNull(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (trimmed === '') return null;
    return trimmed;
  }

  private assertStrategyBasedShape(payload: ClassificationPayload): void {
    if (!payload.strategyId || !payload.tacticId || !payload.planId) {
      throw new BadRequestException(
        `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.STRATEGY_BASED_REQUIRES_STRATEGY}`,
      );
    }
    if (!payload.indicator) {
      throw new BadRequestException(
        `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.STRATEGY_BASED_REQUIRES_INDICATOR}`,
      );
    }
    if (payload.developmentIssueId) {
      throw new BadRequestException(
        `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.STRATEGY_BASED_FORBIDS_ISSUE}`,
      );
    }
  }

  private assertIssueBasedShape(payload: ClassificationPayload): void {
    if (!payload.developmentIssueId) {
      throw new BadRequestException(
        `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.ISSUE_BASED_REQUIRES_ISSUE}`,
      );
    }
    if (payload.strategyId || payload.tacticId || payload.planId) {
      throw new BadRequestException(
        `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.ISSUE_BASED_FORBIDS_STRATEGY}`,
      );
    }
    if (payload.indicator) {
      throw new BadRequestException(
        `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.ISSUE_BASED_FORBIDS_INDICATOR}`,
      );
    }
  }
}
