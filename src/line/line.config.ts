/**
 * line.config.ts — Wave 86 LINE chatbot module configuration.
 *
 * Centralizes env-var access and fail-fast assertion helpers for the
 * LINE Messaging API channel AND the LINE Login OIDC channel. Mirrors
 * the W83 `assertJwtSecret()` pattern: a missing secret MUST raise an
 * explicit error at first call site instead of silently degrading to an
 * "always reject" state that could be mistaken for a working signature
 * guard with no real protection.
 *
 * CLAUDE.md references:
 *   - §17.11 No role exemption — channel secret governs an integrity
 *     boundary, not a permission. Boot MUST fail loudly when missing.
 *   - W86 discovery report §J Security/abuse — webhook is public, secret
 *     is the ONLY proof of authenticity. Treat as critical config.
 *   - W86-BE-LINE-LOGIN-OAUTH §17.9 — OIDC client_id/secret + JWKS URI
 *     are also integrity-bound. Same fail-closed posture.
 *
 * Two distinct channels live here:
 *   1. Messaging API channel — `LINE_CHANNEL_SECRET` — HMAC for webhook
 *      signature verification.
 *   2. Login channel — `LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET`,
 *      `LINE_LOGIN_CALLBACK_URL` — OAuth/OIDC for account linking.
 */

export const LINE_CHANNEL_SECRET_ENV = 'LINE_CHANNEL_SECRET';

// ---- LINE Login (OIDC) ---------------------------------------------------

export const LINE_LOGIN_CHANNEL_ID_ENV = 'LINE_LOGIN_CHANNEL_ID';
export const LINE_LOGIN_CHANNEL_SECRET_ENV = 'LINE_LOGIN_CHANNEL_SECRET';
export const LINE_LOGIN_CALLBACK_URL_ENV = 'LINE_LOGIN_CALLBACK_URL';
export const LINE_LOGIN_ISSUER_ENV = 'LINE_LOGIN_ISSUER';
export const LINE_JWKS_URI_ENV = 'LINE_JWKS_URI';
export const FRONTEND_URL_ENV = 'FRONTEND_URL';

export const LINE_LOGIN_DEFAULT_ISSUER = 'https://access.line.me';
export const LINE_LOGIN_DEFAULT_JWKS_URI =
  'https://api.line.me/oauth2/v2.1/certs';
export const LINE_LOGIN_AUTHORIZE_URL =
  'https://access.line.me/oauth2/v2.1/authorize';
export const LINE_LOGIN_TOKEN_URL =
  'https://api.line.me/oauth2/v2.1/token';
export const LINE_LOGIN_PROFILE_URL = 'https://api.line.me/v2/profile';

// ---- Messaging API (outbound) -------------------------------------------

/**
 * Channel ACCESS TOKEN env var name. Distinct from `LINE_CHANNEL_SECRET`
 * (which is the HMAC key for inbound webhook verification). The access
 * token is the bearer credential used on every OUTBOUND Reply / Push API
 * call.
 *
 * Operator note (W86 discovery report §pre-deploy checklist):
 *   - Generated in the LINE Messaging API console.
 *   - "Long-lived" tokens are recommended for server-side bots (no
 *     refresh rotation required).
 *   - MUST be stored as a secret env var; never commit to source.
 */
export const LINE_CHANNEL_ACCESS_TOKEN_ENV = 'LINE_CHANNEL_ACCESS_TOKEN';

/**
 * Canonical LINE Messaging API endpoints. Hard-coded constants — these
 * are not env-overridable. Region failover is the LINE platform's
 * concern (HTTPS hostname stays constant); local tests intercept via
 * the `axios` instance, not via env redirection.
 */
export const LINE_MESSAGING_REPLY_URL =
  'https://api.line.me/v2/bot/message/reply';
export const LINE_MESSAGING_PUSH_URL =
  'https://api.line.me/v2/bot/message/push';

/**
 * Read and validate the LINE Messaging API channel secret.
 *
 * Throws an Error (NOT NestJS HttpException — this runs before request
 * context exists) if the env var is missing or empty. Callers in the
 * signature guard catch this at first webhook delivery, surfacing the
 * misconfiguration immediately rather than silently 401-ing every event.
 *
 * Returns the trimmed secret on success; never returns null/undefined.
 */
export function assertLineChannelSecret(): string {
  const v = process.env[LINE_CHANNEL_SECRET_ENV];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `[LINE_CONFIG] ${LINE_CHANNEL_SECRET_ENV} required for webhook signature verification`,
    );
  }
  return v.trim();
}

export interface LineLoginConfig {
  channelId: string;
  channelSecret: string;
  callbackUrl: string;
  issuer: string;
  jwksUri: string;
  frontendUrl: string;
}

/**
 * Read and validate the full LINE Login OIDC config bundle.
 *
 * Mirrors `assertLineChannelSecret`: any missing required value (channel
 * id / secret / callback URL / frontend URL) throws synchronously at
 * first call site so the misconfiguration surfaces on the first OAuth
 * attempt rather than silently 503-ing every login.
 *
 * Issuer and JWKS URI fall back to the canonical LINE defaults — they
 * are env-overridable purely to support test fixtures and a future
 * region-specific endpoint, not for production reconfiguration.
 *
 * §17.11 — fail-closed integrity check, not a permission check.
 */
export function assertLineLoginConfig(): LineLoginConfig {
  const channelId = (process.env[LINE_LOGIN_CHANNEL_ID_ENV] ?? '').trim();
  const channelSecret = (
    process.env[LINE_LOGIN_CHANNEL_SECRET_ENV] ?? ''
  ).trim();
  const callbackUrl = (process.env[LINE_LOGIN_CALLBACK_URL_ENV] ?? '').trim();
  const frontendUrl = (process.env[FRONTEND_URL_ENV] ?? '').trim();

  if (!channelId) {
    throw new Error(
      `[LINE_CONFIG] ${LINE_LOGIN_CHANNEL_ID_ENV} required for LINE Login OIDC`,
    );
  }
  if (!channelSecret) {
    throw new Error(
      `[LINE_CONFIG] ${LINE_LOGIN_CHANNEL_SECRET_ENV} required for LINE Login OIDC`,
    );
  }
  if (!callbackUrl) {
    throw new Error(
      `[LINE_CONFIG] ${LINE_LOGIN_CALLBACK_URL_ENV} required for LINE Login OIDC`,
    );
  }
  if (!frontendUrl) {
    throw new Error(
      `[LINE_CONFIG] ${FRONTEND_URL_ENV} required for LINE Login redirect destination`,
    );
  }

  const issuer =
    (process.env[LINE_LOGIN_ISSUER_ENV] ?? '').trim() || LINE_LOGIN_DEFAULT_ISSUER;
  const jwksUri =
    (process.env[LINE_JWKS_URI_ENV] ?? '').trim() || LINE_LOGIN_DEFAULT_JWKS_URI;

  return {
    channelId,
    channelSecret,
    callbackUrl,
    issuer,
    jwksUri,
    frontendUrl,
  };
}

/**
 * Read and validate the LINE Messaging API channel ACCESS TOKEN.
 *
 * Lazily called at the moment a Reply / Push request is being built —
 * NOT at module boot. This lets the application boot in test / CI
 * environments that have no LINE credentials, while still failing
 * loudly the first time a real outbound message attempt is made.
 *
 * The lazy-assert pattern mirrors `assertLineChannelSecret` but with a
 * different lifecycle: webhook signature verification is on the inbound
 * critical path (so it asserts on first webhook hit), whereas messaging
 * is opt-in (so it asserts on first send attempt). The end result is
 * identical — a missing credential surfaces as a loud error rather
 * than a silent 401.
 *
 * Throws plain `Error` (not `HttpException`) so it propagates uniformly
 * regardless of whether the caller is inside a request scope, a Bull
 * worker, or an EventEmitter handler.
 */
export function assertLineChannelAccessToken(): string {
  const v = process.env[LINE_CHANNEL_ACCESS_TOKEN_ENV];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `[LINE_CONFIG] ${LINE_CHANNEL_ACCESS_TOKEN_ENV} required for messaging`,
    );
  }
  return v.trim();
}
