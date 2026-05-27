/**
 * Frozen Thai error copy per SECURITY-01 §7.13.
 *
 * Anti-enumeration: every credential / TOTP / eligibility error path
 * returns the SAME generic message. The internal `outcome` enum carries
 * the precise reason for the audit row — the user-facing string does not.
 */
export const BACKUP_LOGIN_DENIED_MESSAGE =
  'ไม่สามารถเข้าสู่ระบบสำรองได้ในขณะนี้ กรุณาตรวจสอบข้อมูลและลองอีกครั้ง หรือติดต่อผู้ดูแลระบบ';

export const BACKUP_RATE_LIMITED_MESSAGE =
  'คำขอบ่อยเกินไป กรุณารอสักครู่และลองอีกครั้ง';

export const BACKUP_LOGIN_DENIED_CODE = 'BACKUP_LOGIN_DENIED';
export const BACKUP_RATE_LIMITED_CODE = 'RATE_LIMITED';
export const SESSION_INVALIDATED_CODE = 'SESSION_INVALIDATED';
export const PASSWORD_CHANGE_REQUIRED_CODE = 'PASSWORD_CHANGE_REQUIRED';
export const WEAK_PASSWORD_CODE = 'WEAK_PASSWORD';

/**
 * SECURITY-01 §7.12.1 — FROZEN outcome enum (every audit row carries
 * one of these values). Service code MUST reference these constants
 * — never inline string literals.
 *
 * Wave wave-backup-login-profile-self-enroll / BE-01 — added 3
 * outcomes for the new profile self-enroll surface:
 *   - `SELF_ENROLL_SUCCESS` — successful self-enrollment via
 *     POST /backup-credentials/self-enroll
 *   - `WRONG_TOTP` — internal-only outcome for change-password TOTP
 *     verification failure. NEVER returned to the caller — the
 *     response body is the generic anti-enum 401 (SECURITY-01 §7.7
 *     row "/change-password TOTP invalid / expired / replayed").
 *     This outcome lives in the audit row so super-admin can
 *     distinguish "wrong old password" vs "wrong TOTP" attempts.
 *   - `NOT_ELIGIBLE` already existed and is reused on the
 *     self-enroll "already exists" anti-enum branch.
 */
export const BACKUP_OUTCOME = {
  SUCCESS: 'success',
  INVALID_CREDENTIALS: 'invalid_credentials',
  INVALID_TOTP: 'invalid_totp',
  MFA_REQUIRED: 'mfa_required',
  MUST_CHANGE_PASSWORD: 'must_change_password',
  LOCKED: 'locked',
  LOCKED_24H: 'locked_24h',
  FROZEN: 'frozen',
  KILLSWITCH_OFF: 'killswitch_off',
  NOT_ELIGIBLE: 'not_eligible',
  RATE_LIMITED: 'rate_limited',
  BOOTSTRAP: 'bootstrap',
  CHALLENGE_EXPIRED: 'challenge_expired',
  SELF_ENROLL_SUCCESS: 'self_enroll_success',
  WRONG_TOTP: 'wrong_totp',
} as const;

export type BackupAttemptOutcome =
  (typeof BACKUP_OUTCOME)[keyof typeof BACKUP_OUTCOME];
