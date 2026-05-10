/**
 * W110-BE-01 — Orphan Cleanup pre-written reason texts.
 *
 * Source of truth: CLAUDE.md §18.6 + docs/workflow-orphan-cleanup.md
 * (Reason Text Mapping). The exact path of THIS file is FROZEN — see
 * CLAUDE.md §18.6 and docs/tasks/wave110/W110-BE-01-orphan-cleanup-service.md
 * §7.1.
 *
 * The strings produced by these factories are written verbatim into
 * `tracking_status.staff_remark` whenever the auto-cascade runs. They are
 * RESERVED — no other feature may emit a `staffRemark` that matches one of
 * these literal templates, otherwise the FE-02 owner-banner heuristic
 * (CLAUDE.md §18.7 + workflow doc Notification Semantics) would misfire.
 *
 * `bookType` argument values (FROZEN labels):
 *   - `'PLAN'`        -> 'แผนพัฒนาท้องถิ่น'
 *   - `'REVISION'`    -> 'ฉบับแก้ไข/เปลี่ยนแปลง'
 *   - `'SUPPLEMENT'`  -> 'ฉบับเพิ่มเติม'
 *
 * The factories accept the already-translated Thai book type label so the
 * reason templates remain decoupled from the book-kind discriminator.
 * `BOOK_TYPE_LABELS` is exported alongside so call sites have a single
 * lookup.
 */

export type OrphanCleanupBookKind = 'PLAN' | 'REVISION' | 'SUPPLEMENT';

export const BOOK_TYPE_LABELS: Readonly<Record<OrphanCleanupBookKind, string>> =
  Object.freeze({
    PLAN: 'แผนพัฒนาท้องถิ่น',
    REVISION: 'ฉบับแก้ไข/เปลี่ยนแปลง',
    SUPPLEMENT: 'ฉบับเพิ่มเติม',
  });

export const ORPHAN_CLEANUP_REASONS = Object.freeze({
  /** Event 1 — cancel book (CLAUDE.md §18.4). */
  BOOK_CANCELLED: (bookType: string, bookName: string) =>
    `เล่ม${bookType} '${bookName}' ถูกยกเลิก`,

  /** Event 2 — finalize book — owner's court (didn't fix in time). */
  FINALIZE_OWNER_TIMEOUT: (bookName: string) =>
    `คุณไม่ได้แก้ไขให้แล้วเสร็จภายในรอบ '${bookName}' จึงถูกส่งกลับ`,

  /** Event 2 — finalize book — staff's court (review/approval not finished). */
  FINALIZE_STAFF_TIMEOUT: (bookName: string) =>
    `รอบ '${bookName}' ปิดแล้ว โครงการของคุณยังไม่ได้รับการอนุมัติในเวลา`,

  /** Legacy migration backfill (CLAUDE.md §18.9). */
  LEGACY_BACKFILL: 'ระบบทำความสะอาดโครงการคงค้างย้อนหลัง',
} as const);

/**
 * Status -> reason mapping at finalize time (CLAUDE.md §18.6.1, FROZEN).
 *
 * For Event 1 (cancel) every non-soft-deleted row receives
 * `BOOK_CANCELLED(...)` regardless of status, so this table only governs
 * Event 2.
 */
export type FinalizeReasonKind = 'OWNER_TIMEOUT' | 'STAFF_TIMEOUT' | 'NOT_AFFECTED';

export function resolveFinalizeReasonKind(statusName: string): FinalizeReasonKind {
  switch (statusName) {
    case 'Pull_Back':
    case 'Returned_For_Revision':
      return 'OWNER_TIMEOUT';
    case 'Pending':
    case 'Verified':
    case 'Pending_Approval':
      return 'STAFF_TIMEOUT';
    default:
      return 'NOT_AFFECTED';
  }
}
