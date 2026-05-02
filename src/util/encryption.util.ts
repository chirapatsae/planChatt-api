import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scrypt,
  createHmac,
} from 'crypto';
import { promisify } from 'util';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables based on NODE_ENV (.env.production, .env.development, fallback to .env)
const nodeEnv = process.env.NODE_ENV || 'development';
const candidateEnvFile = `.env.${nodeEnv}`;
const resolvedCandidatePath = path.resolve(process.cwd(), candidateEnvFile);
const envFileToLoad = fs.existsSync(resolvedCandidatePath)
  ? resolvedCandidatePath
  : path.resolve(process.cwd(), '.env');

dotenv.config({ path: envFileToLoad });

const algorithm = process.env.ALGORITHM || '';
const secretKey = process.env.SECRET_KEY || '';
const salt = process.env.SALT || '';

// Validate that required environment variables are set
if (!secretKey) {
  throw new Error('SECRET_KEY environment variable is required');
}
if (!salt) {
  throw new Error('SALT environment variable is required');
}
if (!algorithm) {
  throw new Error('ALGORITHM environment variable is required');
}

async function generateKey(): Promise<Buffer> {
  return (await promisify(scrypt)(secretKey, salt, 32)) as Buffer;
}

export async function encryption(citizenId: string): Promise<string> {
  const iv = randomBytes(16);
  const key = await generateKey();
  const cipher = createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(citizenId, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

export async function decryption(encryptedData: string): Promise<string> {
  const [ivHex, encrypted] = encryptedData.split(':');
  const key = await generateKey();
  const decipher = createDecipheriv(algorithm, key, Buffer.from(ivHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function hashCitizenId(citizenId: string): string {
  return createHmac('sha256', secretKey)
    .update(citizenId)
    .digest('hex');
}

/**
 * Deterministic HMAC-SHA256 of a normalized email address.
 *
 * Normalization: trim + lowercase. This is the industry-standard treatment
 * for email comparison — RFC technically permits case-sensitive local
 * parts but every major provider (Gmail, Outlook, etc.) treats addresses
 * as case-insensitive.
 *
 * Used for indexed lookup of users by email when the plaintext column
 * stores ciphertext. Pre-W89 dedup audit at
 * backend/scripts/wave89/audit-email-phone-dedup.sql ensures no two
 * existing rows collide under this normalization.
 *
 * NEVER pass a hashed value to a logger or response payload — hash is for
 * lookup only, not display.
 */
export function hashEmail(email: string): string {
  if (typeof email !== 'string') return '';
  const normalized = email.trim().toLowerCase();
  return createHmac('sha256', secretKey).update(normalized).digest('hex');
}

/**
 * Deterministic HMAC-SHA256 of a normalized phone number.
 *
 * Normalization: strip all non-digit characters. So `081-234-5678`,
 * `0812345678`, `081 234 5678` all hash to the same value.
 *
 * Note: international prefix is NOT auto-stripped. `+66812345678` and
 * `0812345678` would hash differently. The pre-migration audit at
 * backend/scripts/wave89/audit-email-phone-dedup.sql confirmed no
 * existing rows collide under this normalization on the user's data.
 * If a future use case needs E.164 canonicalization, add it as a
 * separate helper rather than changing this one's behavior.
 */
export function hashPhone(phone: string): string {
  if (typeof phone !== 'string') return '';
  const normalized = phone.replace(/\D/g, '');
  return createHmac('sha256', secretKey).update(normalized).digest('hex');
}

/**
 * Generic HMAC-SHA256 with no normalization. Caller is responsible for
 * normalizing before calling. Provided as a building block for future
 * hash uses (e.g. token lookups) so consumers don't have to import
 * `crypto` directly.
 *
 * Do NOT use this for emails or phones — use `hashEmail` / `hashPhone`
 * which apply the canonical normalization.
 */
export function hashSecret(value: string): string {
  if (typeof value !== 'string') return '';
  return createHmac('sha256', secretKey).update(value).digest('hex');
}

/**
 * W90-FIX-01 — Conservative ciphertext detector for AES output produced by
 * `encryption()`. The ciphertext shape is `<32-hex-iv>:<even-hex-payload>`
 * where the IV is exactly 16 bytes (32 hex chars) and the payload is hex.
 *
 * Properties:
 *   - Pure, sync, zero deps. Safe to call on every read boundary.
 *   - Returns false for plaintext-with-colon strings (e.g. `a:b`, URLs,
 *     timestamps), empty strings, null, undefined, non-strings.
 *   - Returns true ONLY for strings that match the exact `iv:hex` shape.
 *
 * Used by callers that need to decide "is this column already ciphertext
 * (W89 row) or legacy plaintext (pre-W89 row)?" without invoking the
 * decryption pipeline. Centralized here so the heuristic stays consistent
 * across modules — do NOT roll a private copy.
 */
export function isLikelyCiphertext(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const idx = value.indexOf(':');
  if (idx !== 32) return false; // 16-byte IV → 32 hex chars
  if (!/^[0-9a-f]{32}$/.test(value.slice(0, 32))) return false;
  const payload = value.slice(33);
  if (payload.length === 0) return false;
  if (!/^[0-9a-f]+$/.test(payload)) return false;
  return true;
}
