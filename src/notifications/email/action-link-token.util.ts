/**
 * W93-VERIFY-CORE — pure HMAC-SHA256 action-link token signer + verifier.
 *
 * This util is intentionally side-effect free:
 *   - no logging (caller owns logging — see W83 token-masking discipline)
 *   - no DB / I/O
 *   - no NestJS DI (plain TypeScript so it can be imported by the controller,
 *     by `notifications-email.service.ts` for the existing signActionLink
 *     refactor, and by tests without bootstrapping a Nest module)
 *
 * Source of truth:
 *   - CLAUDE.md §4.1 — verifier is integrity, not a workflow authority gate
 *   - CLAUDE.md §12  — verifier MUST NOT write `tracking_status`
 *   - W21 design     — Signed-URL is anti-leak only; recipients still re-auth
 *   - W92            — base URL + path resolution stays in the service
 *   - Q1 / Q2 / Q6   — expiry-only protection, stateless, replayable until expiry
 */

import * as crypto from 'crypto';

const HMAC_HEX_LENGTH = 64; // SHA-256 → 32 bytes → 64 hex chars
const HEX_RE = /^[0-9a-f]+$/;

export type VerifyResult =
  | { valid: true; reason: 'ok' }
  | { valid: false; reason: 'expired' | 'tampered' | 'malformed' };

function resolveSecret(secret?: string): string {
  // Parity with the pre-refactor signActionLink: env var present-but-empty
  // falls through to the dev fallback. W93-DOCS calls out that production
  // deploys MUST set NOTIFY_ACTION_LINK_SECRET.
  if (typeof secret === 'string' && secret.length > 0) return secret;
  const envSecret = process.env.NOTIFY_ACTION_LINK_SECRET;
  if (typeof envSecret === 'string' && envSecret.length > 0) return envSecret;
  return 'dev-insecure-secret';
}

function computeHmacHex(projectId: string, expiry: number, secret: string): string {
  const payload = `${projectId}|${expiry}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Sign the `(projectId, expiry)` tuple. The HMAC string returned here is the
 * `t` query param produced by `notifications-email.service.ts → signActionLink`.
 */
export function signActionLinkToken(args: {
  projectId: string;
  expiry: number;
  secret?: string;
}): string {
  const secret = resolveSecret(args.secret);
  return computeHmacHex(args.projectId, args.expiry, secret);
}

/**
 * Verify a token produced by `signActionLinkToken`.
 *
 * Validation order is fixed and documented in the task spec §7.2:
 *   1. malformed input  (type / format / range checks)
 *   2. expired          (now > expiry)
 *   3. tampered         (HMAC mismatch — constant-time compare)
 *
 * The function NEVER throws — every error path returns a `VerifyResult`.
 */
export function verifyActionLinkToken(args: {
  projectId: string;
  token: string;
  expiry: number;
  now?: number;
  secret?: string;
}): VerifyResult {
  const { projectId, token, expiry } = args;

  // --- malformed checks -----------------------------------------------------
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof token !== 'string') {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof expiry !== 'number' || !Number.isFinite(expiry) || !Number.isInteger(expiry) || expiry <= 0) {
    return { valid: false, reason: 'malformed' };
  }
  // Normalize hex casing — `digest('hex')` returns lowercase, but a client
  // could send uppercase. Buffer.from(..., 'hex') tolerates either, but the
  // length pre-check is on the original string so we normalize first.
  const tokenHex = token.toLowerCase();
  if (tokenHex.length !== HMAC_HEX_LENGTH || !HEX_RE.test(tokenHex)) {
    return { valid: false, reason: 'malformed' };
  }

  // --- expired check --------------------------------------------------------
  const now = typeof args.now === 'number' ? args.now : Math.floor(Date.now() / 1000);
  if (now > expiry) {
    return { valid: false, reason: 'expired' };
  }

  // --- tamper check (constant-time) ----------------------------------------
  const secret = resolveSecret(args.secret);
  const expectedHex = computeHmacHex(projectId, expiry, secret);

  // Buffer length pre-check guards against `RangeError` from
  // `crypto.timingSafeEqual` when buffers differ in length. Since both sides
  // are validated 64-char hex, this is belt-and-braces but cheap.
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const givenBuf = Buffer.from(tokenHex, 'hex');
  if (expectedBuf.length !== givenBuf.length) {
    return { valid: false, reason: 'tampered' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, givenBuf)) {
    return { valid: false, reason: 'tampered' };
  }

  return { valid: true, reason: 'ok' };
}
