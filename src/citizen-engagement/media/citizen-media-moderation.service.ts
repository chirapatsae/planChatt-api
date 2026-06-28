import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';

/**
 * CitizenMediaModerationService — the pluggable content-moderation SEAM (W-M1).
 *
 * §17.2 advisory / §17.3 isolation: this service touches NO entity / DB / project
 * table. It only inspects raw bytes and (optionally) forwards them to an
 * operator-provisioned moderation provider. It owns NO `citizen_*` data and
 * writes NO audit row of its own — the caller records the outcome in the
 * existing `media.upload` audit detail.
 *
 * Config is ENV-ONLY (never client input):
 *   - CITIZEN_MEDIA_MODERATION_URL   — provider endpoint; when SET the seam is
 *                                      active and FAIL-CLOSED.
 *   - CITIZEN_MEDIA_MODERATION_SECRET — optional bearer secret sent as
 *                                       `Authorization: Bearer <secret>`.
 *
 * Behaviour:
 *   - URL set   → POST the cleaned bytes (base64 JSON) to the provider with a
 *                 short timeout. A `deny` verdict → 422. FAIL-CLOSED: any
 *                 provider error / timeout / non-2xx → 422 (never let
 *                 unmoderated bytes through when moderation is expected).
 *   - URL unset → ALLOW (current behaviour) + a ONE-TIME logger.warn so
 *                 operators know the seam is open. This is the documented
 *                 integration point.
 *
 * PDPA: the moderation bytes go ONLY to the configured provider URL (the
 * operator's own service). The bytes are NEVER logged.
 *
 * Imports are deliberately limited to `@nestjs/common` + `axios` (a third-party
 * HTTP client, NOT a project service) so this provider can NEVER participate in
 * a service↔service import cycle.
 */
@Injectable()
export class CitizenMediaModerationService {
  private readonly logger = new Logger(CitizenMediaModerationService.name);

  /** Guards the "unconfigured" warn so it fires at most ONCE per process. */
  private warnedUnconfigured = false;

  /** Short provider timeout (ms) — never block an upload on a slow provider. */
  private static readonly PROVIDER_TIMEOUT_MS = 4000;

  /**
   * Assert the bytes are allowed to be stored/served. Resolves when allowed;
   * throws `422 CITIZEN_MEDIA_REJECTED` (HttpException) on deny or — when a
   * provider IS configured — on ANY provider failure (fail-closed).
   *
   * Returns which path was taken so the caller can record it in the audit
   * detail (`moderated: 'provider' | 'unconfigured'`).
   */
  async assertAllowed(
    bytes: Buffer,
    contentType: string,
  ): Promise<'provider' | 'unconfigured'> {
    const url = process.env.CITIZEN_MEDIA_MODERATION_URL;

    if (!url) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.warn(
          'CITIZEN_MEDIA_MODERATION_URL is not set — media moderation seam is ' +
            'OPEN (images are allowed without external moderation). Set the env ' +
            'var to enable fail-closed content moderation.',
        );
      }
      return 'unconfigured';
    }

    let allowed: boolean;
    try {
      allowed = await this.callProvider(url, bytes, contentType);
    } catch (err) {
      // FAIL-CLOSED: a provider IS configured but the call failed
      // (timeout / network / non-2xx / malformed response). Never let
      // unmoderated bytes through when moderation is expected. Log the
      // error WITHOUT the bytes (PDPA).
      this.logger.warn(
        `Media moderation provider call failed; failing closed (422). ` +
          `reason=${this.describeError(err)}`,
      );
      throw new HttpException('CITIZEN_MEDIA_REJECTED', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    if (!allowed) {
      throw new HttpException('CITIZEN_MEDIA_REJECTED', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    return 'provider';
  }

  /**
   * POST the bytes to the provider and resolve the allow/deny verdict.
   * Throws on any transport / protocol failure so `assertAllowed` can
   * fail-closed. The bytes are sent base64-encoded in a JSON body.
   */
  private async callProvider(
    url: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<boolean> {
    const secret = process.env.CITIZEN_MEDIA_MODERATION_SECRET;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (secret) {
      headers.Authorization = `Bearer ${secret}`;
    }

    const res = await axios.post(
      url,
      { contentType, data: bytes.toString('base64') },
      {
        headers,
        timeout: CitizenMediaModerationService.PROVIDER_TIMEOUT_MS,
        // We interpret the verdict ourselves — but a non-2xx is a provider
        // failure and MUST fail-closed, so let axios throw on non-2xx
        // (default validateStatus rejects < 200 || >= 300).
        responseType: 'json',
      },
    );

    return this.interpretVerdict(res.data);
  }

  /**
   * Interpret a provider response into an allow/deny boolean. A response that
   * does not clearly say "allowed" is treated as a failure (caller fail-closes).
   * Accepts the common shapes: `{ allowed: boolean }` or
   * `{ verdict: 'allow' | 'deny' }`.
   */
  private interpretVerdict(data: unknown): boolean {
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (typeof obj.allowed === 'boolean') {
        return obj.allowed;
      }
      if (typeof obj.verdict === 'string') {
        const v = obj.verdict.toLowerCase();
        if (v === 'allow' || v === 'allowed' || v === 'pass') {
          return true;
        }
        if (v === 'deny' || v === 'denied' || v === 'reject' || v === 'rejected') {
          return false;
        }
      }
    }
    // Unrecognised schema → treat as a provider failure (fail-closed).
    throw new Error('CITIZEN_MEDIA_MODERATION_BAD_RESPONSE');
  }

  /** Describe an error for the log WITHOUT leaking the moderation bytes (PDPA). */
  private describeError(err: unknown): string {
    if (err && typeof err === 'object') {
      const e = err as { code?: unknown; response?: { status?: unknown }; message?: unknown };
      if (e.response && typeof e.response === 'object' && e.response.status != null) {
        return `http_status=${String(e.response.status)}`;
      }
      if (e.code != null) {
        return `code=${String(e.code)}`;
      }
      if (typeof e.message === 'string') {
        return e.message;
      }
    }
    return 'unknown';
  }
}
