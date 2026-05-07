/**
 * W63-BE-AGG-01 — unit tests for `normalizeDisplayText`.
 *
 * Coverage:
 *   - null / undefined / empty passthrough
 *   - single item (no change)
 *   - two/three+ inline items
 *   - already-newline-separated (idempotent)
 *   - decimal preservation (1.5)
 *   - currency preservation (฿1.50)
 *   - real-world trailing-typo input
 *   - idempotency f(f(x)) === f(x)
 */

import { normalizeDisplayText } from '../display-text-normalize';

describe('normalizeDisplayText (W63-BE-AGG-01)', () => {
  describe('null / empty input', () => {
    it('returns null for null', () => {
      expect(normalizeDisplayText(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(normalizeDisplayText(undefined)).toBeNull();
    });

    it('returns empty string for empty string', () => {
      expect(normalizeDisplayText('')).toBe('');
    });

    it('returns null for non-string runtime input', () => {
      // Defensive — TS contract says string | null | undefined, but
      // raw-mode JOINs occasionally hand back numbers. Coerce to null.
      expect(normalizeDisplayText(123 as unknown as string)).toBeNull();
    });
  });

  describe('single-item input (no change)', () => {
    it('leaves "1. xxx" unchanged', () => {
      expect(normalizeDisplayText('1. xxx')).toBe('1. xxx');
    });

    it('leaves a single-sentence prose unchanged', () => {
      expect(normalizeDisplayText('โครงการพัฒนาทางเดินเท้า')).toBe(
        'โครงการพัฒนาทางเดินเท้า',
      );
    });
  });

  describe('inline numbered list splitting', () => {
    it('splits two-item inline list', () => {
      expect(normalizeDisplayText('1. xxx 2. yyy')).toBe('1. xxx\n2. yyy');
    });

    it('splits three-item inline list', () => {
      expect(normalizeDisplayText('1. xxx 2. yyy 3. zzz')).toBe(
        '1. xxx\n2. yyy\n3. zzz',
      );
    });

    it('splits four-item inline list', () => {
      expect(normalizeDisplayText('1. a 2. b 3. c 4. d')).toBe(
        '1. a\n2. b\n3. c\n4. d',
      );
    });

    it('handles Thai content between markers', () => {
      expect(
        normalizeDisplayText(
          '1. เพื่อพัฒนาคุณภาพชีวิต 2. เพื่อยกระดับเศรษฐกิจ 3. เพื่อสร้างความยั่งยืน',
        ),
      ).toBe(
        '1. เพื่อพัฒนาคุณภาพชีวิต\n2. เพื่อยกระดับเศรษฐกิจ\n3. เพื่อสร้างความยั่งยืน',
      );
    });
  });

  describe('already-newline-separated input (idempotent)', () => {
    it('does not introduce double newlines', () => {
      expect(normalizeDisplayText('1. xxx\n2. yyy')).toBe('1. xxx\n2. yyy');
    });

    it('three-item already-broken list remains unchanged', () => {
      expect(normalizeDisplayText('1. xxx\n2. yyy\n3. zzz')).toBe(
        '1. xxx\n2. yyy\n3. zzz',
      );
    });
  });

  describe('decimal / currency preservation', () => {
    it('does not split decimals like "1.5"', () => {
      expect(normalizeDisplayText('งบ 1.5 ล้าน')).toBe('งบ 1.5 ล้าน');
    });

    it('does not split currency like "฿1.50"', () => {
      expect(normalizeDisplayText('฿1.50')).toBe('฿1.50');
    });

    it('does not split prose containing decimals between numbered items absent', () => {
      expect(normalizeDisplayText('ราคา 1.5 ล้าน 2.3 ล้าน')).toBe(
        'ราคา 1.5 ล้าน 2.3 ล้าน',
      );
    });

    it('does not split a lone trailing digit-dot like "… 5."', () => {
      expect(normalizeDisplayText('สิ้นสุดที่ขั้นตอน 5.')).toBe(
        'สิ้นสุดที่ขั้นตอน 5.',
      );
    });
  });

  describe('real-world trailing-typo input', () => {
    it('splits "1. xxx ได้a 2. yyy" before "2."', () => {
      expect(normalizeDisplayText('1. xxx ได้a 2. yyy')).toBe(
        '1. xxx ได้a\n2. yyy',
      );
    });

    it('splits the screenshot example before "2. เพื่อ"', () => {
      const input = 'เพื่อให้ประชาชนได้a 2. เพื่อยกระดับ';
      expect(normalizeDisplayText(input)).toBe(
        'เพื่อให้ประชาชนได้a\n2. เพื่อยกระดับ',
      );
    });
  });

  describe('idempotency', () => {
    const SAMPLES = [
      null,
      undefined,
      '',
      '1. xxx',
      '1. xxx 2. yyy',
      '1. xxx 2. yyy 3. zzz',
      '1. xxx\n2. yyy',
      'งบ 1.5 ล้าน',
      '฿1.50',
      '1. xxx ได้a 2. yyy',
      'ราคา 1.5 ล้าน 2.3 ล้าน',
      'สิ้นสุดที่ขั้นตอน 5.',
    ];

    it.each(SAMPLES.map((s) => [JSON.stringify(s), s]))(
      'f(f(%s)) === f(%s)',
      (_label, input) => {
        const once = normalizeDisplayText(input);
        const twice = normalizeDisplayText(once);
        expect(twice).toBe(once);
      },
    );
  });
});
