/**
 * Tests for `deriveReadinessLabel`.
 *
 * Wave LAO-STRATEGY-AI-PARITY Followup G+R Coherence (2026-05-22).
 *
 * The helper must be a pure function from score → band label, with band
 * thresholds matching the existing reviewer prompt thresholds:
 *   - 85-100 → "พร้อมส่ง"
 *   - 60-84  → "ควรปรับปรุง"
 *   - 0-59   → "ต้องแก้ไขก่อนส่ง"
 *
 * Edge behavior (clamp + degrade) is exercised explicitly so future
 * refactors cannot quietly drop the safeguards.
 */

import {
  deriveReadinessLabel,
  READINESS_LABEL_BANDS,
} from './readiness-label';

describe('deriveReadinessLabel', () => {
  describe('canonical band thresholds', () => {
    it.each([
      [100, READINESS_LABEL_BANDS.READY],
      [90, READINESS_LABEL_BANDS.READY],
      [85, READINESS_LABEL_BANDS.READY],
      [84, READINESS_LABEL_BANDS.IMPROVE],
      [72, READINESS_LABEL_BANDS.IMPROVE],
      [60, READINESS_LABEL_BANDS.IMPROVE],
      [59, READINESS_LABEL_BANDS.REWORK],
      [40, READINESS_LABEL_BANDS.REWORK],
      [0, READINESS_LABEL_BANDS.REWORK],
    ])('score %i → "%s"', (score, expected) => {
      expect(deriveReadinessLabel(score)).toBe(expected);
    });
  });

  describe('production-bug regression — score=59 must NOT map to "พร้อมส่ง"', () => {
    it('59 is REWORK (was the bug: LLM said "พร้อมส่ง" with score=59)', () => {
      // Production observation 2026-05-22 — the LLM-supplied label could
      // disagree with the numeric score. Deterministic computation closes
      // that gap forever.
      expect(deriveReadinessLabel(59)).toBe(
        READINESS_LABEL_BANDS.REWORK,
      );
      expect(deriveReadinessLabel(59)).not.toBe(
        READINESS_LABEL_BANDS.READY,
      );
    });
  });

  describe('out-of-range inputs clamp into a valid band', () => {
    it('score above 100 clamps to READY', () => {
      expect(deriveReadinessLabel(150)).toBe(READINESS_LABEL_BANDS.READY);
    });
    it('score below 0 clamps to REWORK', () => {
      expect(deriveReadinessLabel(-25)).toBe(
        READINESS_LABEL_BANDS.REWORK,
      );
    });
  });

  describe('non-finite inputs degrade to REWORK (most conservative band)', () => {
    it('NaN → REWORK', () => {
      expect(deriveReadinessLabel(Number.NaN)).toBe(
        READINESS_LABEL_BANDS.REWORK,
      );
    });
    it('+Infinity → REWORK (advisory degrade)', () => {
      expect(deriveReadinessLabel(Number.POSITIVE_INFINITY)).toBe(
        READINESS_LABEL_BANDS.REWORK,
      );
    });
    it('-Infinity → REWORK', () => {
      expect(deriveReadinessLabel(Number.NEGATIVE_INFINITY)).toBe(
        READINESS_LABEL_BANDS.REWORK,
      );
    });
  });

  describe('canonical Thai strings — frozen contract', () => {
    it('returns exactly one of the 3 Thai band labels (no whitespace, no diacritic drift)', () => {
      const labels = [85, 70, 30].map(deriveReadinessLabel);
      expect(labels).toEqual([
        'พร้อมส่ง',
        'ควรปรับปรุง',
        'ต้องแก้ไขก่อนส่ง',
      ]);
    });
  });
});
