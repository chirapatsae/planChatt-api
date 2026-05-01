/**
 * line-signature.guard.ts — Wave 86.
 *
 * NestJS guard that verifies the `X-Line-Signature` HMAC-SHA256 header
 * on every inbound LINE webhook request. This is the SOLE mechanism
 * proving the request originated from LINE Corp; failure semantics
 * mirror an authentication failure (401, no info leak).
 *
 * Algorithm (per LINE Messaging API docs):
 *   sig = base64(hmacSha256(key=LINE_CHANNEL_SECRET, message=rawBody))
 *
 * Compared against the header using `crypto.timingSafeEqual` to defeat
 * length-based and timing oracle attacks.
 *
 * CRITICAL — RAW BODY REQUIREMENT:
 *   The HMAC is computed over the EXACT bytes LINE transmitted, not a
 *   re-stringified parsed JSON object. Any whitespace difference,
 *   key-order shuffle, or unicode normalization would invalidate the
 *   signature. Therefore the application MUST be bootstrapped with
 *   `NestFactory.create(AppModule, { rawBody: true })` so this guard
 *   can read `request.rawBody` (a `Buffer`) directly. If the buffer is
 *   absent, the guard fails closed (401) rather than computing a
 *   signature over the parsed JSON, which would produce a bogus pass
 *   under specific payload shapes.
 *
 * CLAUDE.md references:
 *   - §17.11 No role exemption — signature failure cannot be bypassed
 *     by any role; the secret IS the integrity boundary.
 *   - W83 structured Logger pattern — failure logs are PII-free, no
 *     header value, no body content.
 *
 * Failure logging:
 *   - Bad/missing signature → `webhook.signature.mismatch ip=... at=...`
 *   - Missing rawBody → `webhook.rawbody.missing ip=... at=...`
 *   - Missing channel secret → throws Error at first call (boot-time
 *     equivalent for delayed loaders); operator must restart with env.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { Request } from 'express';
import { assertLineChannelSecret } from './line.config';

/**
 * Express request shape augmented with the NestJS `rawBody` Buffer.
 * Available only when `NestFactory.create(..., { rawBody: true })`
 * was used at bootstrap.
 */
type RawBodyRequest = Request & { rawBody?: Buffer };

@Injectable()
export class LineSignatureGuard implements CanActivate {
  private readonly logger = new Logger(LineSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest>();
    const ip = this.safeClientIp(req);
    const at = new Date().toISOString();

    // Header is case-insensitive in Express; LINE sends `x-line-signature`.
    const header = req.headers['x-line-signature'];
    const headerSig = Array.isArray(header) ? header[0] : header;

    if (!headerSig || typeof headerSig !== 'string') {
      this.logger.warn(
        `webhook.signature.missing ip=${ip} at=${at}`,
      );
      throw new UnauthorizedException();
    }

    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) {
      // Defensive: if main.ts forgot `rawBody: true`, NEVER fall back
      // to JSON.stringify(req.body). That would produce a bogus pass
      // for byte-equivalent re-serializations and a silent failure
      // otherwise. Fail closed.
      this.logger.warn(
        `webhook.rawbody.missing ip=${ip} at=${at}`,
      );
      throw new UnauthorizedException();
    }

    const secret = assertLineChannelSecret();
    const computed = crypto
      .createHmac('sha256', secret)
      .update(raw)
      .digest('base64');

    // timingSafeEqual requires equal-length buffers. Length-mismatch is
    // an immediate non-match without leaking the ratio of correct
    // prefix bytes.
    const a = Buffer.from(computed, 'utf8');
    const b = Buffer.from(headerSig, 'utf8');
    if (a.length !== b.length) {
      this.logger.warn(
        `webhook.signature.mismatch ip=${ip} at=${at}`,
      );
      throw new UnauthorizedException();
    }

    let ok = false;
    try {
      ok = crypto.timingSafeEqual(a, b);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.logger.warn(
        `webhook.signature.mismatch ip=${ip} at=${at}`,
      );
      throw new UnauthorizedException();
    }

    return true;
  }

  /**
   * Extract a client IP for logging without leaking sensitive
   * forwarded-header chains. Falls back to a stable placeholder when
   * IP resolution is ambiguous; avoids logging full XFF strings which
   * may carry corporate proxy IPs that are themselves PII-adjacent.
   */
  private safeClientIp(req: Request): string {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return ip.replace(/[^\w:.\-]/g, '_').slice(0, 64);
  }
}
