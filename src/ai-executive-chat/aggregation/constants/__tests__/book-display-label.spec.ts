/**
 * Wave AI-EXEC-CHAT-BOOK-LABEL-DOUBLING-FIX (2026-07-18) — unit tests for
 * `bookDisplayLabel`, the deterministic self-contained book-label normaliser
 * used by the roster / head-book envelopes (rules #33 / #61 / #62).
 *
 * Contract:
 *   - already-prefixed labels (main constant + fallback templates) → unchanged
 *   - description-verbatim labels (no "เล่ม") → gain exactly one prefix
 *   - empty / blank / null / undefined → "" (never a bare "เล่ม")
 *   - idempotent: f(f(x)) === f(x)
 */
import {
  bookDisplayLabel,
  REVISION_ROUND_LABEL_MAIN,
} from '../revision-round-label';

describe('bookDisplayLabel', () => {
  it('leaves already-prefixed labels untouched (main constant + fallbacks)', () => {
    expect(bookDisplayLabel(REVISION_ROUND_LABEL_MAIN)).toBe('เล่มหลัก');
    expect(bookDisplayLabel('เล่มหลัก')).toBe('เล่มหลัก');
    expect(bookDisplayLabel('เล่มแก้ไขครั้งที่ 1')).toBe('เล่มแก้ไขครั้งที่ 1');
    expect(bookDisplayLabel('เล่มเปลี่ยนแปลงครั้งที่ 2')).toBe(
      'เล่มเปลี่ยนแปลงครั้งที่ 2',
    );
    expect(bookDisplayLabel('เล่มเพิ่มเติมครั้งที่ 1')).toBe(
      'เล่มเพิ่มเติมครั้งที่ 1',
    );
  });

  it('prepends exactly one "เล่ม" to description-verbatim labels', () => {
    expect(bookDisplayLabel('แก้ไข ครั้งที่ 1/2569')).toBe(
      'เล่มแก้ไข ครั้งที่ 1/2569',
    );
    expect(bookDisplayLabel('เปลี่ยนแปลง ครั้งที่ 1/2569')).toBe(
      'เล่มเปลี่ยนแปลง ครั้งที่ 1/2569',
    );
    expect(bookDisplayLabel('เพิ่มเติม ครั้งที่ 3')).toBe(
      'เล่มเพิ่มเติม ครั้งที่ 3',
    );
  });

  it('never doubles the prefix — the whole point of the fix', () => {
    const once = bookDisplayLabel('แก้ไข ครั้งที่ 1/2569');
    expect(once).toBe('เล่มแก้ไข ครั้งที่ 1/2569');
    // Applying "เล่ม" prepend blindly would give "เล่มเล่มแก้ไข…"; helper must not.
    expect(once.startsWith('เล่มเล่ม')).toBe(false);
    expect(bookDisplayLabel(REVISION_ROUND_LABEL_MAIN).startsWith('เล่มเล่ม')).toBe(
      false,
    );
  });

  it('is idempotent: f(f(x)) === f(x)', () => {
    for (const raw of [
      'เล่มหลัก',
      'แก้ไข ครั้งที่ 1/2569',
      'เปลี่ยนแปลง ครั้งที่ 1/2569',
      'เล่มเพิ่มเติมครั้งที่ 1',
    ]) {
      const once = bookDisplayLabel(raw);
      expect(bookDisplayLabel(once)).toBe(once);
    }
  });

  it('empty / blank / null / undefined → "" (never a bare "เล่ม")', () => {
    expect(bookDisplayLabel('')).toBe('');
    expect(bookDisplayLabel('   ')).toBe('');
    expect(bookDisplayLabel(null)).toBe('');
    expect(bookDisplayLabel(undefined)).toBe('');
  });

  it('trims surrounding whitespace before deciding on the prefix', () => {
    expect(bookDisplayLabel('  แก้ไข ครั้งที่ 1/2569  ')).toBe(
      'เล่มแก้ไข ครั้งที่ 1/2569',
    );
    expect(bookDisplayLabel('  เล่มหลัก  ')).toBe('เล่มหลัก');
  });
});
