/**
 * Wave 22 B1 — Shared email-masking utility.
 *
 * Extracted from `NotificationsEmailService.maskEmail` (Wave 21) so that
 * the email stats surfaces (`EmailStatsService` / controller) can reuse
 * the same masking behavior without depending on the transport service.
 *
 * Behavior MUST remain byte-for-byte identical to the Wave 21 inline
 * implementation:
 *   - empty / non-string / missing '@'  → '***'
 *   - local part length ≤ 1             → `***@<domain>`
 *   - otherwise                          → `<first>***@<domain>`
 *
 * This util is pure; no I/O, no logger. Safe to import from any layer
 * (service, controller, DTO mapper).
 *
 * CLAUDE.md cross-refs:
 *   - §4.1  — purely advisory; not a workflow gate
 *   - §17.2 — PII masking is integrity-bound, not a permission
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return '***';
  }
  const [local, domain] = email.split('@');
  if (!local || local.length <= 1) return `***@${domain}`;
  return `${local[0]}***@${domain}`;
}
