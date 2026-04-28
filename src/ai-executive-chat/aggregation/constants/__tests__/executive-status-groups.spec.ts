/**
 * W67-BE-CONST-01 — unit tests for the 4-group executive status rollup.
 *
 * Covers:
 *   - 8 canonical workflow statuses → correct group OR null
 *   - null / undefined / empty / unknown input → null
 *   - Each group resolves to its Thai label
 *   - The label map is deeply frozen
 */
import {
  EXECUTIVE_STATUS_GROUP_LABEL_TH,
  ExecutiveStatusGroup,
  executiveStatusGroupLabelTh,
  mapToExecutiveStatusGroup,
} from '../executive-status-groups';

describe('executive-status-groups', () => {
  describe('mapToExecutiveStatusGroup', () => {
    it('maps Pending → pending_review', () => {
      expect(mapToExecutiveStatusGroup('Pending')).toBe('pending_review');
    });

    it('maps Verified → awaiting_approval', () => {
      expect(mapToExecutiveStatusGroup('Verified')).toBe('awaiting_approval');
    });

    it('maps Pending_Approval → awaiting_approval', () => {
      expect(mapToExecutiveStatusGroup('Pending_Approval')).toBe(
        'awaiting_approval',
      );
    });

    it('maps Approved → approved', () => {
      expect(mapToExecutiveStatusGroup('Approved')).toBe('approved');
    });

    it('maps Rejected → rejected', () => {
      expect(mapToExecutiveStatusGroup('Rejected')).toBe('rejected');
    });

    it('maps Ready → null (not in executive view)', () => {
      expect(mapToExecutiveStatusGroup('Ready')).toBeNull();
    });

    it('maps Pull_Back → null (not in executive view)', () => {
      expect(mapToExecutiveStatusGroup('Pull_Back')).toBeNull();
    });

    it('maps Returned_For_Revision → null (not in executive view)', () => {
      expect(mapToExecutiveStatusGroup('Returned_For_Revision')).toBeNull();
    });

    it('returns null for null input', () => {
      expect(mapToExecutiveStatusGroup(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(mapToExecutiveStatusGroup(undefined)).toBeNull();
    });

    it('returns null for empty-string input', () => {
      expect(mapToExecutiveStatusGroup('')).toBeNull();
    });

    it('returns null for unknown status', () => {
      expect(mapToExecutiveStatusGroup('NotARealStatus')).toBeNull();
    });
  });

  describe('executiveStatusGroupLabelTh', () => {
    it('returns Thai label for pending_review', () => {
      expect(executiveStatusGroupLabelTh('pending_review')).toBe('รอตรวจสอบ');
    });

    it('returns Thai label for awaiting_approval', () => {
      expect(executiveStatusGroupLabelTh('awaiting_approval')).toBe(
        'รออนุมัติ',
      );
    });

    it('returns Thai label for approved', () => {
      expect(executiveStatusGroupLabelTh('approved')).toBe('อนุมัติ');
    });

    it('returns Thai label for rejected', () => {
      expect(executiveStatusGroupLabelTh('rejected')).toBe('เกินศักยภาพ');
    });

    it('returns null for null input', () => {
      expect(executiveStatusGroupLabelTh(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(executiveStatusGroupLabelTh(undefined)).toBeNull();
    });
  });

  describe('EXECUTIVE_STATUS_GROUP_LABEL_TH frozen', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(EXECUTIVE_STATUS_GROUP_LABEL_TH)).toBe(true);
    });

    it('throws on mutation in strict mode', () => {
      'use strict';
      expect(() => {
        // @ts-expect-error — verifying runtime immutability
        EXECUTIVE_STATUS_GROUP_LABEL_TH.pending_review = 'อะไรก็ได้';
      }).toThrow();
    });

    it('contains exactly four group keys', () => {
      const keys = Object.keys(
        EXECUTIVE_STATUS_GROUP_LABEL_TH,
      ) as ExecutiveStatusGroup[];
      expect(keys.sort()).toEqual(
        ['approved', 'awaiting_approval', 'pending_review', 'rejected'].sort(),
      );
    });
  });
});
