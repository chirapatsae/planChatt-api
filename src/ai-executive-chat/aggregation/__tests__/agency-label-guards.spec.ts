/**
 * Wave 58 W58-BE-AGG-02 — agency-label placeholder guard unit tests.
 *
 * Covers the §17.9 belt-and-braces defense:
 *   - regex blacklist rejects the smoking-gun D6 pattern
 *     `/^หน่วยงานที่\s*\d+$/`
 *   - regex blacklist also rejects the English equivalent
 *     `/^agency\s*#?\s*\d+$/i`
 *   - canonical agency names (Thai, English, mixed) pass through
 *   - canonical W57 rule #26 disclosure passes through
 *   - null / undefined / empty values pass (the guard is concerned
 *     with positive matches only)
 *   - the throwing variant uses the stable error-code prefix
 *     `PROJECT_ENVELOPE_AGENCY_PLACEHOLDER` for log filtering.
 *
 * §17.9 — defense scope is server-authored envelope payload, NEVER
 * user-controlled text routed through `<<<USER_INPUT>>>` delimiters.
 * §17.11 — no role exemption; the guard is a structural integrity
 * check, not a permission gate.
 */

import {
  FORBIDDEN_AGENCY_LABEL_PATTERNS,
  AgencyLabelPlaceholderError,
  assertAgencyLabelPlaceholderFree,
  checkAgencyLabelPlaceholder,
} from '../constants/agency-label-guards';
import { PENDING_RESPONSIBLE_AGENCY_DISCLOSURE } from '../constants/revision-round-label';

describe('Wave 58 W58-BE-AGG-02 / agency-label-guards', () => {
  describe('FORBIDDEN_AGENCY_LABEL_PATTERNS — regex blacklist', () => {
    it('rejects "หน่วยงานที่ 2" (the smoking-gun D6 pattern)', () => {
      expect(
        FORBIDDEN_AGENCY_LABEL_PATTERNS.some((rx) => rx.test('หน่วยงานที่ 2')),
      ).toBe(true);
    });

    it('rejects "หน่วยงานที่2" (no whitespace) and "หน่วยงานที่   42" (multi-space)', () => {
      expect(
        FORBIDDEN_AGENCY_LABEL_PATTERNS.some((rx) => rx.test('หน่วยงานที่2')),
      ).toBe(true);
      expect(
        FORBIDDEN_AGENCY_LABEL_PATTERNS.some((rx) =>
          rx.test('หน่วยงานที่   42'),
        ),
      ).toBe(true);
    });

    it('rejects "agency#3", "agency 3", "AGENCY 7", "Agency # 12" (case-insensitive)', () => {
      for (const v of ['agency#3', 'agency 3', 'AGENCY 7', 'Agency # 12']) {
        expect({
          v,
          hit: FORBIDDEN_AGENCY_LABEL_PATTERNS.some((rx) => rx.test(v)),
        }).toEqual({
          v,
          hit: true,
        });
      }
    });

    it('passes canonical agency names (real production-shaped strings)', () => {
      const ok = [
        'องค์การบริหารส่วนจังหวัดนครราชสีมา',
        'อบจ.นครราชสีมา',
        'สำนักปลัด',
        'Department of Public Works',
        'หน่วยงานสาธารณสุข', // contains "หน่วยงาน" but not the "หน่วยงานที่ N" pattern
      ];
      for (const v of ok) {
        expect({
          v,
          hit: FORBIDDEN_AGENCY_LABEL_PATTERNS.some((rx) => rx.test(v)),
        }).toEqual({
          v,
          hit: false,
        });
      }
    });

    it('passes the canonical W57 rule #26 disclosure verbatim', () => {
      expect(
        FORBIDDEN_AGENCY_LABEL_PATTERNS.some((rx) =>
          rx.test(PENDING_RESPONSIBLE_AGENCY_DISCLOSURE),
        ),
      ).toBe(false);
    });

    it('does NOT match "หน่วยงานที่ดี" (Thai word "ดี" follows — no digit)', () => {
      expect(
        FORBIDDEN_AGENCY_LABEL_PATTERNS.some((rx) => rx.test('หน่วยงานที่ดี')),
      ).toBe(false);
    });

    it('does NOT match the empty string', () => {
      expect(FORBIDDEN_AGENCY_LABEL_PATTERNS.some((rx) => rx.test(''))).toBe(
        false,
      );
    });
  });

  describe('checkAgencyLabelPlaceholder()', () => {
    it('returns ok=true for a row with both fields null', () => {
      expect(
        checkAgencyLabelPlaceholder({
          responsibleAgencyName: null,
          responsibleAgencyDisclosure: null,
        }),
      ).toEqual({ ok: true });
    });

    it('returns ok=true for a row with valid name + null disclosure', () => {
      expect(
        checkAgencyLabelPlaceholder({
          responsibleAgencyName: 'อบจ.นครราชสีมา',
          responsibleAgencyDisclosure: null,
        }),
      ).toEqual({ ok: true });
    });

    it('returns ok=true for a row with null name + canonical disclosure', () => {
      expect(
        checkAgencyLabelPlaceholder({
          responsibleAgencyName: null,
          responsibleAgencyDisclosure: PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
        }),
      ).toEqual({ ok: true });
    });

    it('returns ok=false with field=responsibleAgencyName when D6 pattern leaks', () => {
      const r = checkAgencyLabelPlaceholder({
        responsibleAgencyName: 'หน่วยงานที่ 2',
        responsibleAgencyDisclosure: null,
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.field).toBe('responsibleAgencyName');
      expect(r.value).toBe('หน่วยงานที่ 2');
    });

    it('returns ok=false with field=responsibleAgencyDisclosure when placeholder leaks there', () => {
      const r = checkAgencyLabelPlaceholder({
        responsibleAgencyName: null,
        responsibleAgencyDisclosure: 'agency #5',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.field).toBe('responsibleAgencyDisclosure');
    });
  });

  describe('assertAgencyLabelPlaceholderFree()', () => {
    it('does not throw for a valid row', () => {
      expect(() =>
        assertAgencyLabelPlaceholderFree({
          responsibleAgencyName: 'อบจ.นครราชสีมา',
          responsibleAgencyDisclosure: null,
        }),
      ).not.toThrow();
    });

    it('throws AgencyLabelPlaceholderError with the stable error-code prefix', () => {
      try {
        assertAgencyLabelPlaceholderFree({
          responsibleAgencyName: 'หน่วยงานที่ 7',
          responsibleAgencyDisclosure: null,
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(AgencyLabelPlaceholderError);
        expect((e as Error).message).toMatch(
          /^PROJECT_ENVELOPE_AGENCY_PLACEHOLDER:/,
        );
        expect((e as Error).message).toContain('field=responsibleAgencyName');
      }
    });
  });
});
