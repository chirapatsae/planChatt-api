import { validateAiOutput } from './ai-output-validator';

/**
 * Unit tests for validateAiOutput — covers the §N2 relaxed-threshold
 * behaviour introduced by SCANNED_PDF_SUMMARY_HARDENING_P2_VALIDATOR_RELAX.
 *
 * Test style mirrors pii-redactor.spec.ts (describe + it, no framework
 * extras, no mocks). All reason strings asserted here MUST match the
 * operational dashboards already keyed on them — do not rename.
 */
describe('validateAiOutput', () => {
  // A realistic, clean 2-sentence Thai government summary that contains
  // no 8-char substring appearing more than 3 times. Used as the
  // positive baseline in several tests.
  const cleanThaiTopic = 'รายงานการประชุมคณะกรรมการพัฒนาท้องถิ่น';
  const cleanThaiSummary =
    'การประชุมครั้งนี้พิจารณาแผนพัฒนาท้องถิ่นประจำปีงบประมาณถัดไป ' +
    'ที่ประชุมมีมติเห็นชอบร่างแผนและมอบหมายให้เจ้าหน้าที่ดำเนินการต่อไป';

  describe('V1 — happy path', () => {
    it('accepts a clean realistic Thai topic + summary', () => {
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: cleanThaiSummary,
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('V2 — summary too short', () => {
    it('rejects a summary of length <= 20 with the short-summary reason', () => {
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: 'สั้นเกินไป',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/^LOW_AI_QUALITY: summary too short/);
      }
    });
  });

  describe('V3 — 8-char substring appears 4 times → loop detected', () => {
    it('rejects with the loop-detected reason', () => {
      // "ABCDEFGH" appears 4 times, separated by non-matching filler.
      const looped =
        'ABCDEFGH xx ABCDEFGH yy ABCDEFGH zz ABCDEFGH end padding text here.';
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: looped,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(
          'LOW_AI_QUALITY: summary contains a repeating phrase (loop detected)',
        );
      }
    });
  });

  describe('V4 — 8-char substring appears exactly 3 times → accepted', () => {
    it('accepts because threshold is > 3 occurrences (i.e., need ≥ 4 to fail)', () => {
      // "ABCDEFGH" appears exactly 3 times, with enough surrounding text
      // to clear the 20-char minimum and the early-exit length guard.
      const borderline =
        'ABCDEFGH xx ABCDEFGH yy ABCDEFGH -- some trailing narrative text.';
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: borderline,
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('V5 — 7-char Thai word "โครงการ" repeats 3 times → accepted', () => {
    it('accepts because 3 occurrences is under the new ≥4-threshold', () => {
      // Real-world scenario: a legitimate summary of a government project
      // naturally uses "โครงการ" a few times. With maxOccurrences raised from
      // 2 to 3, three uses in varied contexts no longer trip the detector.
      // (The OLD validator with maxOccurrences=2 and minLen=6 would have
      // incorrectly flagged this as a loop.)
      const realistic =
        'โครงการพัฒนาเมืองมีวัตถุประสงค์ยกระดับคุณภาพชีวิต โครงการจะดำเนินการในพื้นที่สามตำบลเป็นระยะเวลาสองปี ผลลัพธ์ที่คาดว่าจะได้รับคือโครงการช่วยสร้างงานและรายได้';
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: realistic,
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('V6 — qualityScore = 0.3 skips the loop detector', () => {
    it('accepts a summary that would otherwise trigger the loop rule', () => {
      const looped =
        'ABCDEFGH xx ABCDEFGH yy ABCDEFGH zz ABCDEFGH end padding text here.';
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: looped,
        qualityScore: 0.3,
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('V7 — qualityScore = 0.7 runs the loop detector', () => {
    it('rejects the same looped summary with the loop-detected reason', () => {
      const looped =
        'ABCDEFGH xx ABCDEFGH yy ABCDEFGH zz ABCDEFGH end padding text here.';
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: looped,
        qualityScore: 0.7,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(
          'LOW_AI_QUALITY: summary contains a repeating phrase (loop detected)',
        );
      }
    });

    it('runs the loop detector at the boundary qualityScore = 0.5 (inclusive)', () => {
      const looped =
        'ABCDEFGH xx ABCDEFGH yy ABCDEFGH zz ABCDEFGH end padding text here.';
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: looped,
        qualityScore: 0.5,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(
          'LOW_AI_QUALITY: summary contains a repeating phrase (loop detected)',
        );
      }
    });
  });

  describe('V8 — qualityScore undefined preserves backward-compatible default', () => {
    it('behaves identically to qualityScore >= 0.5 (detector runs)', () => {
      const looped =
        'ABCDEFGH xx ABCDEFGH yy ABCDEFGH zz ABCDEFGH end padding text here.';
      const withoutScore = validateAiOutput({
        topic: cleanThaiTopic,
        summary: looped,
      });
      const withHighScore = validateAiOutput({
        topic: cleanThaiTopic,
        summary: looped,
        qualityScore: 0.9,
      });
      expect(withoutScore).toEqual(withHighScore);
      expect(withoutScore.ok).toBe(false);
    });

    it('treats NaN / Infinity qualityScore as undefined (detector runs)', () => {
      const looped =
        'ABCDEFGH xx ABCDEFGH yy ABCDEFGH zz ABCDEFGH end padding text here.';
      const nanResult = validateAiOutput({
        topic: cleanThaiTopic,
        summary: looped,
        qualityScore: Number.NaN,
      });
      const infResult = validateAiOutput({
        topic: cleanThaiTopic,
        summary: looped,
        qualityScore: Number.POSITIVE_INFINITY,
      });
      expect(nanResult.ok).toBe(false);
      expect(infResult.ok).toBe(false);
    });
  });

  describe('V9 — summary without meaningful alpha chars', () => {
    it('rejects with the no-letters reason', () => {
      // 27 chars, > 20 minimum, but no Thai/English letters.
      const result = validateAiOutput({
        topic: cleanThaiTopic,
        summary: '1234567890 1234567890 12345',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(
          'LOW_AI_QUALITY: summary has no Thai or English letters',
        );
      }
    });
  });

  describe('V10 — topic too short', () => {
    it('rejects with the topic-too-short reason', () => {
      const result = validateAiOutput({
        topic: 'ab',
        summary: cleanThaiSummary,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/^LOW_AI_QUALITY: topic too short/);
      }
    });
  });

  describe('V11 — topic too long', () => {
    it('rejects with the topic-too-long reason when topic > 100 chars', () => {
      const longTopic = 'a'.repeat(101);
      const result = validateAiOutput({
        topic: longTopic,
        summary: cleanThaiSummary,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/^LOW_AI_QUALITY: topic too long/);
      }
    });
  });
});
