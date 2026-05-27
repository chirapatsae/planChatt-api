import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * AES-256-GCM helper for the backup-login subsystem.
 *
 * SECURITY-01 §7.6 — TOTP secret encryption at rest. The existing
 * `backend/src/util/encryption.util.ts` ships AES-CBC (used for user PII
 * columns). For TOTP secrets we want GCM (authenticated encryption, so a
 * tampered ciphertext fails decrypt instead of returning garbage that
 * `otplib` would feed into the HMAC). The key is derived deterministically
 * from `SECRET_KEY` + `SALT` (same env vars as the existing AES helper),
 * via scrypt, so re-derive on every process boot is stable.
 *
 * Format on disk: `<iv-hex>:<authTag-hex>:<ciphertext-hex>`.
 *
 *   - iv         : 12 bytes (96 bits — NIST SP 800-38D §8.2.1 recommended)
 *   - authTag    : 16 bytes (128 bits — default GCM tag size)
 *   - ciphertext : variable
 *
 * §17.11 — no role exemption; the key is derived from process env, no
 * runtime override path exists.
 */

const SECRET_KEY = process.env.SECRET_KEY || '';
const SALT = process.env.SALT || '';

if (!SECRET_KEY) {
  throw new Error('SECRET_KEY environment variable is required');
}
if (!SALT) {
  throw new Error('SALT environment variable is required');
}

const KEY = scryptSync(SECRET_KEY, SALT, 32);
const ALGO = 'aes-256-gcm';

export function encryptGcm(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptGcm(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptGcm: malformed payload');
  }
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
