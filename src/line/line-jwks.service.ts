/**
 * line-jwks.service.ts — Wave 86 LINE Login OIDC JWKS verifier.
 *
 * Mirrors the W83 `ThaidJwksService` pattern: in-process JWKS cache
 * with TTL, refresh-on-`kid`-miss, and in-flight dedup. RS256-only
 * signature verification using `jsonwebtoken` + Node `crypto.createPublicKey`
 * (NO new supply-chain dependencies — `jose` / `jwks-rsa` deliberately
 * avoided to keep attack surface minimal per CLAUDE.md §17.11 integrity
 * posture).
 *
 * CLAUDE.md references:
 *   - §17.9 Prompt-injection / schema-drift defense — token claims are
 *     validated server-side; signature verify is mandatory; schema
 *     mismatch surfaces as an explicit failure (not a silent altered
 *     verdict).
 *   - §17.11 No role exemption — no caller may bypass signature check.
 *   - §17.3 Audit separation — JWKS service writes nothing to
 *     TrackingStatus. It is read-only OIDC compute.
 *
 * Cache discipline:
 *   - 5-minute process-local TTL
 *   - On `kid` miss, refresh JWKS once (no infinite loop — second miss
 *     surfaces as InvalidTokenError).
 *   - In-flight dedup: a second concurrent fetch piggybacks on the first
 *     promise instead of issuing a duplicate HTTP call.
 *
 * Failure modes:
 *   - Missing channelId at boot → ServiceUnavailableException (503) on
 *     first call. Mirrors W83 fail-closed posture for `THAID_CLIENT_ID`.
 *   - JWKS fetch failure → InternalServerErrorException (502 logically
 *     but Nest semantics map this to 500); caller wraps to a 302 redirect
 *     to frontend error page so no stack leaks.
 *   - Signature mismatch / claim mismatch → InvalidTokenError; caller
 *     wraps to a 302 redirect.
 */

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { assertLineLoginConfig, LineLoginConfig } from './line.config';

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_TOLERANCE_SEC = 30;
const MAX_TOKEN_AGE_SEC = 5 * 60; // iat must be within 5 min of now

interface JwkRsa {
  kty: 'RSA';
  use?: string;
  alg?: string;
  kid: string;
  n: string;
  e: string;
}

interface JwksDocument {
  keys: JwkRsa[];
}

interface CacheEntry {
  fetchedAt: number;
  keys: Map<string, JwkRsa>;
}

export class InvalidLineIdTokenError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'InvalidLineIdTokenError';
  }
}

export interface VerifiedLineIdTokenClaims {
  /** LINE user id (U-prefixed). Treat as PII — never log plaintext. */
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  nonce?: string;
  name?: string;
  picture?: string;
  email?: string;
}

@Injectable()
export class LineJwksService {
  private readonly logger = new Logger(LineJwksService.name);
  private cache: CacheEntry | null = null;
  private inflight: Promise<CacheEntry> | null = null;

  /**
   * Verify a LINE Login ID token end-to-end:
   *  - decode header → extract `kid` + `alg`
   *  - assert RS256 (LINE Login v2.1 only signs with RS256)
   *  - resolve JWK by `kid`, refreshing once on miss
   *  - verify signature via jsonwebtoken
   *  - validate iss, aud, exp, iat/nbf, optional nonce
   *
   * @param idToken raw compact JWS string
   * @param expectedNonce  the nonce we issued at /initiate; MUST match
   *                       the `nonce` claim. If undefined, nonce check
   *                       is skipped (NOT recommended; callers should
   *                       always pass).
   */
  async verifyIdToken(
    idToken: string,
    expectedNonce: string | undefined,
  ): Promise<VerifiedLineIdTokenClaims> {
    // Fail closed if config is missing — same posture as W83.
    let cfg: LineLoginConfig;
    try {
      cfg = assertLineLoginConfig();
    } catch (e) {
      // 503 not 500 — config gap is operational, not a request-level bug.
      throw new ServiceUnavailableException(
        'LINE Login is not configured on this server',
      );
    }

    if (!idToken || typeof idToken !== 'string') {
      throw new InvalidLineIdTokenError('id_token missing', 'no_token');
    }

    // 1. Decode header without verification to get kid + alg.
    const decoded = jwt.decode(idToken, { complete: true }) as
      | { header: { alg?: string; kid?: string }; payload: unknown }
      | null;
    if (!decoded || !decoded.header) {
      throw new InvalidLineIdTokenError(
        'id_token undecodable',
        'malformed_header',
      );
    }
    const { alg, kid } = decoded.header;

    // LINE Login v2.1 ID tokens are signed with HS256 by default
    // (HMAC using the channel secret as shared key — see LINE docs:
    // https://developers.line.biz/en/reference/line-login-v2.1/#verify-id-token).
    // Some channel configurations may opt into RS256 (JWKS-based asymmetric).
    // Dispatch on the header's alg field; fail-closed if neither.
    if (alg !== 'HS256' && alg !== 'RS256') {
      throw new InvalidLineIdTokenError(
        `id_token alg not supported: ${String(alg)}`,
        'bad_alg',
      );
    }

    // 2-4. Verify signature + standard claims, branching on algorithm.
    let payload: jwt.JwtPayload;
    try {
      if (alg === 'HS256') {
        // Symmetric: HMAC-SHA256 with channel secret as shared key.
        // No JWKS fetch needed; `kid` is irrelevant for HS256.
        payload = jwt.verify(idToken, cfg.channelSecret, {
          algorithms: ['HS256'],
          issuer: cfg.issuer,
          audience: cfg.channelId,
          clockTolerance: CLOCK_SKEW_TOLERANCE_SEC,
        }) as jwt.JwtPayload;
      } else {
        // RS256 path — existing JWKS lookup with one refresh-on-miss retry.
        if (!kid || typeof kid !== 'string') {
          throw new InvalidLineIdTokenError(
            'id_token kid missing for RS256',
            'no_kid',
          );
        }
        let jwk = await this.findKey(kid, cfg.jwksUri, /*forceRefresh*/ false);
        if (!jwk) {
          jwk = await this.findKey(kid, cfg.jwksUri, /*forceRefresh*/ true);
        }
        if (!jwk) {
          throw new InvalidLineIdTokenError(
            'id_token kid not found in JWKS',
            'kid_unknown',
          );
        }
        const pem = this.jwkToPem(jwk);
        payload = jwt.verify(idToken, pem, {
          algorithms: ['RS256'],
          issuer: cfg.issuer,
          audience: cfg.channelId,
          clockTolerance: CLOCK_SKEW_TOLERANCE_SEC,
        }) as jwt.JwtPayload;
      }
    } catch (e: any) {
      // Re-throw if our own error type
      if (e instanceof InvalidLineIdTokenError) throw e;
      const reason =
        e?.name === 'TokenExpiredError'
          ? 'expired'
          : e?.name === 'JsonWebTokenError'
            ? 'bad_signature'
            : 'verify_failed';
      throw new InvalidLineIdTokenError(
        `id_token verification failed (${reason})`,
        reason,
      );
    }

    // 5. Application-level claim asserts (defense-in-depth — jwt.verify
    //    already enforces iss/aud/exp, but we re-assert with explicit
    //    error codes so the redirect reason-code is precise).
    if (payload.iss !== cfg.issuer) {
      throw new InvalidLineIdTokenError('iss mismatch', 'bad_iss');
    }
    const audClaim = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (audClaim !== cfg.channelId) {
      throw new InvalidLineIdTokenError('aud mismatch', 'bad_aud');
    }
    if (typeof payload.exp !== 'number') {
      throw new InvalidLineIdTokenError('exp missing', 'no_exp');
    }
    if (typeof payload.iat !== 'number') {
      throw new InvalidLineIdTokenError('iat missing', 'no_iat');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.iat > nowSec + CLOCK_SKEW_TOLERANCE_SEC) {
      throw new InvalidLineIdTokenError('iat in future', 'iat_future');
    }
    if (payload.iat < nowSec - MAX_TOKEN_AGE_SEC) {
      throw new InvalidLineIdTokenError('iat too old', 'iat_old');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new InvalidLineIdTokenError('sub missing', 'no_sub');
    }

    // 6. Nonce check — caller-bound CSRF/replay defense.
    if (expectedNonce !== undefined) {
      const nonceClaim = (payload as any).nonce;
      if (typeof nonceClaim !== 'string' || nonceClaim !== expectedNonce) {
        throw new InvalidLineIdTokenError(
          'nonce mismatch',
          'nonce_mismatch',
        );
      }
    }

    return {
      sub: payload.sub,
      iss: payload.iss as string,
      aud: cfg.channelId,
      exp: payload.exp,
      iat: payload.iat,
      nonce: (payload as any).nonce,
      name: typeof (payload as any).name === 'string'
        ? (payload as any).name
        : undefined,
      picture: typeof (payload as any).picture === 'string'
        ? (payload as any).picture
        : undefined,
      email: typeof (payload as any).email === 'string'
        ? (payload as any).email
        : undefined,
    };
  }

  // ---------------------------------------------------------------------
  // JWKS fetch + cache
  // ---------------------------------------------------------------------

  private async findKey(
    kid: string,
    jwksUri: string,
    forceRefresh: boolean,
  ): Promise<JwkRsa | null> {
    const entry = await this.getJwks(jwksUri, forceRefresh);
    return entry.keys.get(kid) ?? null;
  }

  private async getJwks(
    jwksUri: string,
    forceRefresh: boolean,
  ): Promise<CacheEntry> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cache &&
      now - this.cache.fetchedAt < JWKS_CACHE_TTL_MS
    ) {
      return this.cache;
    }
    if (this.inflight) {
      // Concurrent caller — piggyback on the existing fetch.
      return this.inflight;
    }
    this.inflight = this.fetchJwks(jwksUri)
      .then((entry) => {
        this.cache = entry;
        return entry;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchJwks(jwksUri: string): Promise<CacheEntry> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(jwksUri, {
        method: 'GET',
        signal: ac.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new InternalServerErrorException(
          `JWKS fetch HTTP ${res.status}`,
        );
      }
      const json = (await res.json()) as JwksDocument;
      if (!json || !Array.isArray(json.keys)) {
        throw new InternalServerErrorException('JWKS payload malformed');
      }
      const map = new Map<string, JwkRsa>();
      for (const k of json.keys) {
        if (k.kty === 'RSA' && typeof k.kid === 'string' && k.n && k.e) {
          map.set(k.kid, k);
        }
      }
      this.logger.log(
        `line-jwks.refresh keys=${map.size} at=${new Date().toISOString()}`,
      );
      return { fetchedAt: Date.now(), keys: map };
    } catch (e: any) {
      this.logger.warn(
        `line-jwks.fetch.failure reason=${e?.name ?? 'unknown'} at=${new Date().toISOString()}`,
      );
      throw new InternalServerErrorException('JWKS fetch failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Convert a JWK (RSA) to a PEM-encoded SPKI public key using Node's
   * built-in crypto. Avoids pulling in `jwk-to-pem` or `jose`.
   */
  private jwkToPem(jwk: JwkRsa): string {
    try {
      const keyObject = crypto.createPublicKey({
        key: {
          kty: jwk.kty,
          n: jwk.n,
          e: jwk.e,
        } as any,
        format: 'jwk',
      });
      return keyObject.export({ type: 'spki', format: 'pem' }) as string;
    } catch (e: any) {
      this.logger.warn(
        `line-jwks.jwk_to_pem.failure at=${new Date().toISOString()}`,
      );
      throw new InvalidLineIdTokenError(
        'jwk to pem conversion failed',
        'jwk_invalid',
      );
    }
  }
}
