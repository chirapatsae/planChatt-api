/**
 * W64-FE-03 — regression tests for `display-text-normalize`.
 *
 * Covers both helpers:
 *   - `normalizeDisplayText` (W63) — inline-numbered split into newlines
 *   - `formatNumberedListMarkdown` (W64) — newline-separated numbered
 *     content → indented markdown ordered-list block
 *
 * §17.9 — these are pure display-only helpers; tests cover input
 * tolerance (null/empty/non-string) plus idempotency and shape.
 */
import {
  normalizeDisplayText,
  formatNumberedListMarkdown,
} from './display-text-normalize';

describe('normalizeDisplayText (W63)', () => {
  it('returns null for null / undefined', () => {
    expect(normalizeDisplayText(null)).toBeNull();
    expect(normalizeDisplayText(undefined)).toBeNull();
  });

  it('returns empty string unchanged', () => {
    expect(normalizeDisplayText('')).toBe('');
  });

  it('splits inline "1. xxx 2. yyy" into newlines', () => {
    const out = normalizeDisplayText('1. xxx 2. yyy 3. zzz');
    expect(out).toBe('1. xxx\n2. yyy\n3. zzz');
  });

  it('does not split decimals like "1.5 ล้าน"', () => {
    const out = normalizeDisplayText('งบประมาณ 1.5 ล้านบาท');
    expect(out).toBe('งบประมาณ 1.5 ล้านบาท');
  });

  it('is idempotent — f(f(x)) === f(x)', () => {
    const once = normalizeDisplayText('1. a 2. b 3. c');
    const twice = normalizeDisplayText(once);
    expect(twice).toBe(once);
  });

  it('handles Thai prose between numbers', () => {
    const out = normalizeDisplayText('1. ศึกษาความเป็นไปได้ 2. ออกแบบ');
    expect(out).toBe('1. ศึกษาความเป็นไปได้\n2. ออกแบบ');
  });
});

describe('formatNumberedListMarkdown (W64-FE-03)', () => {
  it('returns null for null / undefined', () => {
    expect(formatNumberedListMarkdown(null)).toBeNull();
    expect(formatNumberedListMarkdown(undefined)).toBeNull();
  });

  it('returns empty string unchanged', () => {
    expect(formatNumberedListMarkdown('')).toBe('');
  });

  it('formats a "1. xxx\\n2. yyy" pre-normalized input as nested OL', () => {
    const out = formatNumberedListMarkdown('1. xxx\n2. yyy');
    expect(out).toBe('\n     1. xxx\n     2. yyy');
  });

  it('formats inline "1. xxx 2. yyy 3. zzz" by normalizing first', () => {
    const out = formatNumberedListMarkdown('1. xxx 2. yyy 3. zzz');
    expect(out).toBe('\n     1. xxx\n     2. yyy\n     3. zzz');
  });

  it('returns plain prose unchanged (no numbered shape)', () => {
    const prose = 'เพื่อพัฒนาคุณภาพชีวิตประชาชน';
    expect(formatNumberedListMarkdown(prose)).toBe(prose);
  });

  it('returns single-item numbered text as normalized prose (needs ≥ 2 items)', () => {
    // Only one numbered item is not a "list" — leave normalized form.
    const out = formatNumberedListMarkdown('1. only one item');
    expect(out).toBe('1. only one item');
  });

  it('honors a custom indent', () => {
    const out = formatNumberedListMarkdown('1. a\n2. b', { indent: '  ' });
    expect(out).toBe('\n  1. a\n  2. b');
  });

  it('preserves Thai content per item', () => {
    const out = formatNumberedListMarkdown(
      '1. ศึกษา 2. ออกแบบ 3. ก่อสร้าง',
    );
    expect(out).toBe(
      '\n     1. ศึกษา\n     2. ออกแบบ\n     3. ก่อสร้าง',
    );
  });

  it('does not split decimals', () => {
    const out = formatNumberedListMarkdown('งบประมาณ 1.5 ล้านบาท');
    expect(out).toBe('งบประมาณ 1.5 ล้านบาท');
  });
});
