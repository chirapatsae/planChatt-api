/**
 * W93-VERIFY-CORE — unit tests for the action-link signer/verifier util.
 *
 * Coverage targets:
 *   - Round-trip sign → verify success
 *   - Each row of the §7.2 behavior matrix
 *   - Constant-time compare path (well-formed but wrong HMAC → 'tampered')
 *   - Default secret resolution (env present, env empty, env absent)
 *   - Fixed-input HMAC regression (acceptance criterion §10)
 */

import * as crypto from 'crypto';
import {
  signActionLinkToken,
  verifyActionLinkToken,
  VerifyResult,
} from './action-link-token.util';

const FIXED_PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const FIXED_EXPIRY = 1900000000;
const FIXED_SECRET = 'fixed-test-secret';

const farFuture = (): number => Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

describe('action-link-token.util', () => {
  // -------------------------------------------------------------------------
  // Round-trip + signer determinism
  // -------------------------------------------------------------------------

  describe('signActionLinkToken', () => {
    it('produces a deterministic 64-char lowercase hex token for fixed inputs', () => {
      const tok = signActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        expiry: FIXED_EXPIRY,
        secret: FIXED_SECRET,
      });
      expect(tok).toHaveLength(64);
      expect(tok).toMatch(/^[0-9a-f]{64}$/);

      // Acceptance criterion §10 — token equals SHA-256 HMAC of literal payload.
      const expected = crypto
        .createHmac('sha256', FIXED_SECRET)
        .update(`${FIXED_PROJECT_ID}|${FIXED_EXPIRY}`)
        .digest('hex');
      expect(tok).toBe(expected);
    });

    it('round-trips through verifyActionLinkToken to { valid: true, reason: ok }', () => {
      const expiry = farFuture();
      const token = signActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        expiry,
        secret: FIXED_SECRET,
      });
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual<VerifyResult>({ valid: true, reason: 'ok' });
    });
  });

  // -------------------------------------------------------------------------
  // Behavior matrix — each row gets a dedicated test
  // -------------------------------------------------------------------------

  describe('verifyActionLinkToken — malformed rows', () => {
    it('rejects projectId that is not a non-empty string (empty string)', () => {
      const result = verifyActionLinkToken({
        projectId: '',
        token: 'a'.repeat(64),
        expiry: farFuture(),
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });

    it('rejects projectId that is not a string (typeof number)', () => {
      const result = verifyActionLinkToken({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        projectId: 123 as any,
        token: 'a'.repeat(64),
        expiry: farFuture(),
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });

    it('rejects token that is not a string', () => {
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        token: 12345 as any,
        expiry: farFuture(),
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });

    it('rejects token of wrong length (e.g. 32 hex chars)', () => {
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token: 'a'.repeat(32),
        expiry: farFuture(),
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });

    it('rejects token containing non-hex characters', () => {
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token: 'z'.repeat(64),
        expiry: farFuture(),
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });

    it('rejects expiry that is not a positive finite integer (NaN)', () => {
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token: 'a'.repeat(64),
        expiry: NaN,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });

    it('rejects expiry that is negative', () => {
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token: 'a'.repeat(64),
        expiry: -1,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });

    it('rejects expiry that is non-integer', () => {
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token: 'a'.repeat(64),
        expiry: 1.5,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });

    it('rejects expiry that is Infinity', () => {
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token: 'a'.repeat(64),
        expiry: Infinity,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'malformed' });
    });
  });

  describe('verifyActionLinkToken — expired row', () => {
    it('returns expired when now > expiry', () => {
      const expiry = 1000;
      const token = signActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        expiry,
        secret: FIXED_SECRET,
      });
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
        now: 2000,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'expired' });
    });

    it('does NOT consider now === expiry as expired (boundary)', () => {
      const expiry = 1000;
      const token = signActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        expiry,
        secret: FIXED_SECRET,
      });
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
        now: 1000,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: true, reason: 'ok' });
    });
  });

  describe('verifyActionLinkToken — tampered row (constant-time path)', () => {
    it('returns tampered when HMAC is well-formed length but wrong (wrong secret)', () => {
      const expiry = farFuture();
      const token = signActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        expiry,
        secret: 'attacker-secret',
      });
      // Token is a real 64-char hex HMAC (so NOT 'malformed') but signed with
      // a different secret — exercises the timingSafeEqual mismatch branch.
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'tampered' });
    });

    it('returns tampered when projectId differs from the one used at sign time', () => {
      const expiry = farFuture();
      const token = signActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        expiry,
        secret: FIXED_SECRET,
      });
      const result = verifyActionLinkToken({
        projectId: '00000000-0000-0000-0000-000000000002',
        token,
        expiry,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'tampered' });
    });

    it('returns tampered when expiry differs from the one used at sign time', () => {
      const expiry = farFuture();
      const token = signActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        expiry,
        secret: FIXED_SECRET,
      });
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry: expiry + 1, // shifted by 1s — HMAC will not match
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: false, reason: 'tampered' });
    });

    it('accepts uppercase hex tokens (normalized to lowercase before compare)', () => {
      const expiry = farFuture();
      const token = signActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        expiry,
        secret: FIXED_SECRET,
      });
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token: token.toUpperCase(),
        expiry,
        secret: FIXED_SECRET,
      });
      expect(result).toEqual({ valid: true, reason: 'ok' });
    });
  });

  // -------------------------------------------------------------------------
  // Default secret resolution
  // -------------------------------------------------------------------------

  describe('default secret resolution', () => {
    const ENV_KEY = 'NOTIFY_ACTION_LINK_SECRET';
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (originalEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalEnv;
    });

    it('uses NOTIFY_ACTION_LINK_SECRET when set', () => {
      process.env[ENV_KEY] = 'env-secret-value';
      const expiry = farFuture();
      const token = signActionLinkToken({ projectId: FIXED_PROJECT_ID, expiry });
      // Verifier with explicit matching secret arg should succeed.
      const ok = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
        secret: 'env-secret-value',
      });
      expect(ok).toEqual({ valid: true, reason: 'ok' });
      // Verifier with wrong explicit secret should tamper.
      const bad = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
        secret: 'different',
      });
      expect(bad).toEqual({ valid: false, reason: 'tampered' });
    });

    it('falls back to dev-insecure-secret when env is empty string', () => {
      process.env[ENV_KEY] = '';
      const expiry = farFuture();
      const token = signActionLinkToken({ projectId: FIXED_PROJECT_ID, expiry });
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
        secret: 'dev-insecure-secret',
      });
      expect(result).toEqual({ valid: true, reason: 'ok' });
    });

    it('falls back to dev-insecure-secret when env is unset', () => {
      delete process.env[ENV_KEY];
      const expiry = farFuture();
      const token = signActionLinkToken({ projectId: FIXED_PROJECT_ID, expiry });
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
        secret: 'dev-insecure-secret',
      });
      expect(result).toEqual({ valid: true, reason: 'ok' });
    });

    it('signer + verifier agree end-to-end using only env-resolved secret on both sides', () => {
      process.env[ENV_KEY] = 'shared-env-secret';
      const expiry = farFuture();
      const token = signActionLinkToken({ projectId: FIXED_PROJECT_ID, expiry });
      const result = verifyActionLinkToken({
        projectId: FIXED_PROJECT_ID,
        token,
        expiry,
      });
      expect(result).toEqual({ valid: true, reason: 'ok' });
    });
  });

  // -------------------------------------------------------------------------
  // Total-function guarantee — never throws
  // -------------------------------------------------------------------------

  describe('total-function guarantee', () => {
    it('does not throw for any pathological combination', () => {
      expect(() =>
        verifyActionLinkToken({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          projectId: undefined as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          token: null as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expiry: 'not-a-number' as any,
        }),
      ).not.toThrow();
    });
  });
});
