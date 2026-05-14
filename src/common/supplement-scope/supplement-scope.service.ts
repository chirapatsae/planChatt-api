import { ForbiddenException, Injectable } from '@nestjs/common';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import {
  SUPPLEMENT_SCOPE_ERROR_CODES,
  SUPPLEMENT_SCOPE_ERROR_MESSAGES,
} from './supplement-scope.constants';

/**
 * Constants for the §1 classification rule. The supplement workflow
 * authorises ONLY อบจ.นครราชสีมา (`amphoe.id = 3001` AND
 * `localAdministrativeOrganization.id = 3001027`). Kept inline here so the
 * gate is self-contained and does not import from a domain feature module.
 *
 * See CLAUDE.md §1 "Classification — Important Constraint": classification
 * MUST use both ids — presence of a single field does NOT imply agency.
 */
const AGENCY_AMPHOE_ID = '3001';
const AGENCY_LAO_ID = '3001027';

/**
 * SupplementScopeService — CLAUDE.md §1, §2, §4
 *
 * Canonical owner-scope gate for every SPG owner-scoped endpoint
 * (create / createDraft / updateDraft / publishDraft / pull_back).
 *
 * This is the SINGLE source of truth for the SUPP-1 Q1 + Q2 gate. BE-01,
 * BE-02, BE-03 MUST import this service rather than re-implementing the
 * classification check inline. Staff-controlled transitions (Pending →
 * Verified, etc.) MUST NOT route through this gate — staff gating is by
 * role + `WorkHistoryGovernmentAgencyResponsibility` (BE-02's concern,
 * see docs/workflow-add-project-supplement.md §12 / §13).
 *
 * The service is stateless and accepts a fully-resolved `WorkHistory`
 * (i.e. the caller has already invoked `WorkHistoryLookupService.getCurrent`
 * inside its transaction). The §2 `workStatus = approved` check is
 * re-invoked here defensively — if the caller forgot to run it earlier,
 * this gate still blocks. This matches the "validation order" preamble
 * in `docs/workflow-add-project-supplement.md` §7.
 *
 * Validation order inside this service:
 *   1. workStatus = approved             (CLAUDE.md §2)
 *   2. classification === 'agency'        (CLAUDE.md §1; throws on LAO or edge)
 *
 * The §1 classification check fires AFTER §2 because per CLAUDE.md
 * "VALIDATION ORDER" `workStatus` precedes classification — an
 * agency-classified user with `workStatus = pending` MUST still be
 * rejected on workStatus, not on classification.
 */
@Injectable()
export class SupplementScopeService {
  constructor(
    private readonly workHistoryLookup: WorkHistoryLookupService,
  ) {}

  /**
   * Assert the caller may perform an owner-scoped SPG action.
   *
   * Throws:
   *   - `UnauthorizedException` — from the delegated
   *     `WorkHistoryLookupService.assertWorkStatusApproved` when
   *     `workStatus.name !== 'approved'`.
   *   - `ForbiddenException(LAO_NOT_ALLOWED_ON_SUPPLEMENT)` — caller is
   *     LAO-classified (any `localAdministrativeOrganization.id` other
   *     than `3001027`).
   *   - `ForbiddenException(SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION)` —
   *     caller is neither agency nor LAO (missing data, malformed
   *     WorkHistory, etc.).
   *
   * Returns void on success. Caller continues with scope binding /
   * workflow checks per the workflow doc §7.
   */
  assertSupplementOwnerScope(workHistory: WorkHistory): void {
    // 1. §2 — workStatus gate (precedes classification per validation order).
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);

    // 2. §1 — classification gate.
    const amphoeId = workHistory.amphoe?.id;
    const laoId = workHistory.localAdministrativeOrganization?.id;

    const isAgency =
      amphoeId === AGENCY_AMPHOE_ID && laoId === AGENCY_LAO_ID;
    if (isAgency) {
      return;
    }

    // LAO classification per CLAUDE.md §1: a workHistory with a valid
    // `localAdministrativeOrganization` whose id is NOT the อบจ.นม id
    // (`3001027`) is classified as `lao`.
    const isLao =
      !!laoId && laoId !== AGENCY_LAO_ID;
    if (isLao) {
      throw new ForbiddenException(
        `${SUPPLEMENT_SCOPE_ERROR_CODES.LAO_NOT_ALLOWED_ON_SUPPLEMENT}: ${SUPPLEMENT_SCOPE_ERROR_MESSAGES.LAO_NOT_ALLOWED_ON_SUPPLEMENT}`,
      );
    }

    // Edge case: malformed WorkHistory (no LAO at all, or amphoe mismatch
    // with no LAO context to classify as `lao`). Reject with the
    // "requires agency" error rather than silently letting it through.
    throw new ForbiddenException(
      `${SUPPLEMENT_SCOPE_ERROR_CODES.SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION}: ${SUPPLEMENT_SCOPE_ERROR_MESSAGES.SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION}`,
    );
  }
}
