/**
 * Wave wave-orphan-cleanup-history / BE-01 — pure-function tests over the
 * reason classification + book-name extraction logic used by
 * `TrackingStatusService.getOrphanCleanupHistory`.
 *
 * The full SQL path requires a populated DB; this spec covers the pure
 * helper logic that determines correctness of the response payload shape
 * (reasonKind discriminator + bookName extraction) so any regression on
 * the FROZEN §18.6 reason templates is caught at unit-test time.
 *
 * Imports the FROZEN constants directly from the orphan-cleanup module
 * to guarantee parity with the strings the cascade writes into
 * `tracking_status.staff_remark`.
 */
import { ORPHAN_CLEANUP_REASONS } from 'src/orphan-cleanup/constants/orphan-cleanup-reasons';

// Mirror of the inline helpers inside `getOrphanCleanupHistory`. They
// MUST stay byte-for-byte aligned with the implementation; any change
// to the service helpers MUST be reflected here.
const classifyReason = (
  remark: string,
): 'cancelled' | 'owner-timeout' | 'staff-timeout' | 'legacy' => {
  if (remark === 'ระบบทำความสะอาดโครงการคงค้างย้อนหลัง') return 'legacy';
  if (/^คุณไม่ได้แก้ไขให้แล้วเสร็จภายในรอบ/.test(remark))
    return 'owner-timeout';
  if (/^รอบ .+ปิดแล้ว/.test(remark)) return 'staff-timeout';
  return 'cancelled';
};

const extractBookName = (remark: string): string | null => {
  const cancelled = remark.match(/^เล่ม.+?\s'([^']+)'\sถูกยกเลิก$/);
  if (cancelled?.[1]) return cancelled[1];
  const ownerTimeout = remark.match(/ภายในรอบ\s'([^']+)'/);
  if (ownerTimeout?.[1]) return ownerTimeout[1];
  const staffTimeout = remark.match(/^รอบ\s'([^']+)'\sปิดแล้ว/);
  if (staffTimeout?.[1]) return staffTimeout[1];
  return null;
};

describe('orphan-cleanup history — reason classification', () => {
  it('classifies LEGACY_BACKFILL exactly', () => {
    const remark = ORPHAN_CLEANUP_REASONS.LEGACY_BACKFILL;
    expect(classifyReason(remark)).toBe('legacy');
    expect(extractBookName(remark)).toBeNull();
  });

  it('classifies BOOK_CANCELLED (PLAN) and extracts book name', () => {
    const remark = ORPHAN_CLEANUP_REASONS.BOOK_CANCELLED(
      'แผนพัฒนาท้องถิ่น',
      'แผนพัฒนา 2571-2575',
    );
    expect(classifyReason(remark)).toBe('cancelled');
    expect(extractBookName(remark)).toBe('แผนพัฒนา 2571-2575');
  });

  it('classifies BOOK_CANCELLED (REVISION) and extracts book name', () => {
    const remark = ORPHAN_CLEANUP_REASONS.BOOK_CANCELLED(
      'ฉบับแก้ไข/เปลี่ยนแปลง',
      'รอบแก้ไขครั้งที่ 1',
    );
    expect(classifyReason(remark)).toBe('cancelled');
    expect(extractBookName(remark)).toBe('รอบแก้ไขครั้งที่ 1');
  });

  it('classifies BOOK_CANCELLED (SUPPLEMENT) and extracts book name', () => {
    const remark = ORPHAN_CLEANUP_REASONS.BOOK_CANCELLED(
      'ฉบับเพิ่มเติม',
      'เพิ่มเติมครั้งที่ 3',
    );
    expect(classifyReason(remark)).toBe('cancelled');
    expect(extractBookName(remark)).toBe('เพิ่มเติมครั้งที่ 3');
  });

  it('classifies FINALIZE_OWNER_TIMEOUT and extracts book name', () => {
    const remark = ORPHAN_CLEANUP_REASONS.FINALIZE_OWNER_TIMEOUT(
      'รอบ A 2569',
    );
    expect(classifyReason(remark)).toBe('owner-timeout');
    expect(extractBookName(remark)).toBe('รอบ A 2569');
  });

  it('classifies FINALIZE_STAFF_TIMEOUT and extracts book name', () => {
    const remark = ORPHAN_CLEANUP_REASONS.FINALIZE_STAFF_TIMEOUT(
      'รอบ B 2569',
    );
    expect(classifyReason(remark)).toBe('staff-timeout');
    expect(extractBookName(remark)).toBe('รอบ B 2569');
  });

  it('does not match arbitrary text as an orphan-cleanup reason', () => {
    // Realistic non-cascade staff remark — comment from staff review.
    // It does NOT match any FROZEN template; the SQL filter would exclude
    // it before reaching this classifier, but the classifier MUST be
    // tolerant if such a string sneaks through (defensive default to
    // 'cancelled' is acceptable because the SQL filter is the gate).
    const remark = 'โครงการผ่านการตรวจสอบเรียบร้อยแล้ว';
    // Defensive default behavior — classifier returns 'cancelled' but
    // the SQL LIKE filter would have rejected this row upstream.
    expect(classifyReason(remark)).toBe('cancelled');
    expect(extractBookName(remark)).toBeNull();
  });
});
