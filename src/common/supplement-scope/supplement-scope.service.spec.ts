import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { SupplementScopeService } from './supplement-scope.service';
import {
  SUPPLEMENT_SCOPE_ERROR_CODES,
} from './supplement-scope.constants';

/**
 * SUPP-1 BE-04 — Unit specs for the canonical owner-scope gate.
 *
 * Covers:
 *   1. approved agency อบจ.นม → passes
 *   2. approved LAO caller → throws LAO_NOT_ALLOWED_ON_SUPPLEMENT
 *   3. approved but malformed WorkHistory (no LAO, wrong amphoe, missing
 *      data) → throws SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION
 *   4. workStatus != approved → throws UnauthorizedException
 *      (delegated to WorkHistoryLookupService.assertWorkStatusApproved —
 *      this is the existing canonical workStatus error)
 *
 * Strategy: build a minimal fake `WorkHistory` per case. We instantiate
 * the real `WorkHistoryLookupService` (it is a pure helper — its
 * `assertWorkStatusApproved` is synchronous and DB-free) so the spec
 * exercises the actual delegation chain.
 */

const AGENCY_AMPHOE_ID = '3001';
const AGENCY_LAO_ID = '3001027';

function makeWorkHistory(opts: {
  amphoeId?: string | null;
  laoId?: string | null;
  workStatusName?: string | null;
}): WorkHistory {
  const wh = {
    amphoe: opts.amphoeId ? { id: opts.amphoeId } : null,
    localAdministrativeOrganization: opts.laoId ? { id: opts.laoId } : null,
    workStatus: opts.workStatusName ? { name: opts.workStatusName } : null,
  } as unknown as WorkHistory;
  return wh;
}

describe('SupplementScopeService.assertSupplementOwnerScope', () => {
  let service: SupplementScopeService;

  beforeEach(() => {
    const lookup = new WorkHistoryLookupService();
    service = new SupplementScopeService(lookup);
  });

  it('passes for approved agency อบจ.นม (amphoe=3001 AND lao=3001027)', () => {
    const wh = makeWorkHistory({
      amphoeId: AGENCY_AMPHOE_ID,
      laoId: AGENCY_LAO_ID,
      workStatusName: 'approved',
    });
    expect(() => service.assertSupplementOwnerScope(wh)).not.toThrow();
  });

  it('rejects approved LAO caller with LAO_NOT_ALLOWED_ON_SUPPLEMENT', () => {
    const wh = makeWorkHistory({
      amphoeId: '3002',
      laoId: '3002001',
      workStatusName: 'approved',
    });
    expect(() => service.assertSupplementOwnerScope(wh)).toThrow(
      ForbiddenException,
    );
    try {
      service.assertSupplementOwnerScope(wh);
    } catch (err) {
      expect((err as ForbiddenException).message).toContain(
        SUPPLEMENT_SCOPE_ERROR_CODES.LAO_NOT_ALLOWED_ON_SUPPLEMENT,
      );
    }
  });

  it('rejects approved caller from agency-amphoe but non-อบจ.นม lao with LAO_NOT_ALLOWED_ON_SUPPLEMENT', () => {
    // amphoe=3001 but lao!=3001027 — classified as `lao` per §1
    // (classification requires BOTH ids; amphoe alone does not qualify).
    const wh = makeWorkHistory({
      amphoeId: AGENCY_AMPHOE_ID,
      laoId: '3001099',
      workStatusName: 'approved',
    });
    expect(() => service.assertSupplementOwnerScope(wh)).toThrow(
      ForbiddenException,
    );
    try {
      service.assertSupplementOwnerScope(wh);
    } catch (err) {
      expect((err as ForbiddenException).message).toContain(
        SUPPLEMENT_SCOPE_ERROR_CODES.LAO_NOT_ALLOWED_ON_SUPPLEMENT,
      );
    }
  });

  it('rejects approved caller with no localAdministrativeOrganization with SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION', () => {
    const wh = makeWorkHistory({
      amphoeId: '3002',
      laoId: null,
      workStatusName: 'approved',
    });
    expect(() => service.assertSupplementOwnerScope(wh)).toThrow(
      ForbiddenException,
    );
    try {
      service.assertSupplementOwnerScope(wh);
    } catch (err) {
      expect((err as ForbiddenException).message).toContain(
        SUPPLEMENT_SCOPE_ERROR_CODES.SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION,
      );
    }
  });

  it('rejects when workStatus is not approved (UnauthorizedException, before classification)', () => {
    // Even though this WorkHistory matches agency classification on §1,
    // workStatus precedes classification per CLAUDE.md VALIDATION ORDER.
    const wh = makeWorkHistory({
      amphoeId: AGENCY_AMPHOE_ID,
      laoId: AGENCY_LAO_ID,
      workStatusName: 'pending',
    });
    expect(() => service.assertSupplementOwnerScope(wh)).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when workStatus is missing entirely (UnauthorizedException)', () => {
    const wh = makeWorkHistory({
      amphoeId: AGENCY_AMPHOE_ID,
      laoId: AGENCY_LAO_ID,
      workStatusName: null,
    });
    expect(() => service.assertSupplementOwnerScope(wh)).toThrow(
      UnauthorizedException,
    );
  });
});
