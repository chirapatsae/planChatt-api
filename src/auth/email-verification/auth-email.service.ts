import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from 'src/users/entities/user.entity';
import { NotificationsEmailService } from 'src/notifications/email/notifications-email.service';
import { ProjectNotificationEvent } from 'src/notifications/events/project-notification-event';
import {
  signActionLinkToken,
  verifyActionLinkToken,
} from 'src/notifications/email/action-link-token.util';

/**
 * W95-VERIFY-FLOW — Authentication-scope email service.
 *
 * Owns:
 *   - Building the EMAIL_VERIFICATION_REQUEST event envelope.
 *   - Computing the HMAC-bound verify URL whose payload is
 *     `${userId}|${emailHash}|${expiry}` so a mid-flight email change
 *     invalidates the link.
 *   - Delegating transport to NotificationsEmailService.queueEmail so the
 *     verification email travels through the SAME Bull queue + EmailService
 *     chokepoint as every other outbound (W90 sandbox guard remains active).
 *
 * Does NOT own:
 *   - Verification-token storage (stateless HMAC; no DB).
 *   - The W95-GATE check (W95-GATE owns; this event is on the
 *     `BYPASS_VERIFICATION_GATE` set so the gate skips it).
 *   - Marking users verified (UsersService.markEmailVerified — W95-USERS-API).
 *
 * Constraints (CLAUDE.md):
 *   - §4.1  — verification is integrity, not workflow authority.
 *   - §12   — MUST NOT write tracking_status.
 *   - §17.3 — no FK from any AI/audit table to project tables (we do not
 *     create new tables here; we reuse `notification_email_logs` per spec §8).
 *   - W83   — token is a credential. Logged only via first-8-char prefix.
 *   - W89   — email is encrypted at rest; we read `emailHash` (deterministic
 *     HMAC over normalized form) so the binding works without decryption.
 *   - W93   — reuses `signActionLinkToken` HMAC primitive.
 */
@Injectable()
export class AuthEmailService {
  private readonly logger = new Logger(AuthEmailService.name);

  /**
   * 24h expiry — matches spec §3 ("24h-expiry notice"). Expressed in seconds
   * so the unix-second math in `signActionLinkToken` stays clean.
   */
  static readonly VERIFY_LINK_TTL_SECONDS = 24 * 60 * 60;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notificationsEmailService: NotificationsEmailService,
  ) {}

  /**
   * Queue a verification email to the user's CURRENT email address.
   *
   * Spec §3 enumerates two callers:
   *   1. The user-initiated "Resend" button (verify-request endpoint) —
   *      MUST respect `allowEmailNotification`. `bypassAllowEmailNotification`
   *      MUST be false (default).
   *   2. The first-login auto-fire path — MAY set
   *      `bypassAllowEmailNotification = true`. Future wave; not invoked by
   *      this service yet.
   *
   * Spec §9 (account enumeration): callers SHOULD treat any thrown error as
   * a successful no-op so the response shape never reveals user state. This
   * method itself swallows lookup failures and logs them; it does NOT throw.
   */
  async queueVerificationEmail(args: {
    userId: string;
    bypassAllowEmailNotification?: boolean;
  }): Promise<void> {
    const { userId } = args;
    if (typeof userId !== 'string' || userId.length === 0) return;

    // W89 — read `emailHash` (deterministic HMAC) without decrypting the
    // ciphertext column. The hash is what binds the HMAC link, so a later
    // email change (which rotates `emailHash` per UsersService.update) makes
    // the previously-issued link fail HMAC verification. Encrypted ciphertext
    // is NOT read here; the queue path decrypts at SMTP boundary.
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'emailHash', 'firstname', 'lastname'],
    });

    if (!user) {
      this.logger.log(
        `auth.email.verify-request.skipped userId=${userId} reason=user-missing`,
      );
      return;
    }
    if (!user.emailHash) {
      // No email on file — nothing to verify. Per spec §9 we do not surface
      // this to the caller (account enumeration defense lives in the
      // controller's response contract).
      this.logger.log(
        `auth.email.verify-request.skipped userId=${userId} reason=no-email`,
      );
      return;
    }

    const expiry =
      Math.floor(Date.now() / 1000) + AuthEmailService.VERIFY_LINK_TTL_SECONDS;

    // Spec §7 binding: `${userId}|${emailHash}|${expiry}`. We pack the first
    // two fields into the util's `projectId` argument so the underlying
    // HMAC payload becomes `${userId}|${emailHash}|${expiry}` — identical to
    // the spec without forking the W93 util.
    const bindingId = `${user.id}|${user.emailHash}`;
    const token = signActionLinkToken({ projectId: bindingId, expiry });

    // Wave 95 amendment (Pattern B — FE-handled verify): the email link now
    // points at the FRONTEND `/verify-email` route instead of the backend
    // `GET /api/v1/auth/email/verify` redirect. The FE page mounts, calls
    // `POST /api/v1/auth/email/verify-confirm`, and renders the result.
    // Rationale: keeps the user on the FE domain end-to-end (same UX as the
    // W93 advisory banner pattern), so they never see the api-pm.* host in
    // the address bar. The legacy GET endpoint stays mounted for backward
    // compat with W95-original emails already in inboxes.
    const frontendBase = AuthEmailService.resolveFrontendBase();
    const verifyUrl =
      `${frontendBase.replace(/\/+$/, '')}/verify-email` +
      `?u=${encodeURIComponent(user.id)}` +
      `&exp=${expiry}` +
      `&t=${token}`;

    const recipientEmail = `user-${user.id}`; // placeholder for audit-log shape;
    // `sendPreparedJob` decrypts the actual address from `users.email` at the
    // SMTP boundary. The recipient envelope here only needs `userId` so the
    // preference gate + decrypt path can resolve the row. We pass an opaque
    // string for `email` to satisfy the typing contract; it is never used as
    // an SMTP To: header.

    const event: ProjectNotificationEvent = {
      eventType: 'EMAIL_VERIFICATION_REQUEST',
      // No project context — fields below are required by the type but
      // unused by the EMAIL_VERIFICATION_REQUEST template (REQUIRED_TEMPLATE_FIELDS
      // is `['actionLink']` only).
      projectId: user.id,
      projectName: '',
      fromStatus: '',
      toStatus: '',
      actionLink: verifyUrl,
      recipients: [
        {
          userId: user.id,
          email: recipientEmail,
          workHistoryId: '',
        },
      ],
      // `targetKind = 'user'` so the audit row's `target_kind` column is
      // semantically correct (the email targets the User, not a project).
      metadata: { kind: 'user' },
      bypassAllowEmailNotification:
        args.bypassAllowEmailNotification === true ? true : undefined,
    };

    await this.notificationsEmailService.queueEmail(event);

    // W83 — log userId + token prefix only. Never the email, never the
    // emailHash, never the full token.
    const tokenPrefix = token.slice(0, 8);
    this.logger.log(
      `auth.email.verify-request.queued userId=${user.id} token=${tokenPrefix} exp=${expiry}`,
    );
  }

  /**
   * Verify a click on the verification URL.
   *
   * Returns one of:
   *   - { valid: true, userId }  — caller must call markEmailVerified.
   *   - { valid: false, reason } — caller redirects with reason query param.
   *
   * Statelessness: no DB write here. Caller (controller) is responsible for
   * invoking `UsersService.markEmailVerified` after a `valid: true` result.
   * Idempotency lives in `markEmailVerified` (single conditional UPDATE).
   *
   * Email-change-mid-flight defense: we re-load the user's CURRENT
   * `emailHash` and recompute the HMAC binding. If the email has changed
   * since the link was issued, the recomputed binding differs and HMAC
   * verification falls through to `tampered`.
   */
  async verifyToken(args: {
    userId: string;
    token: string;
    expiry: number;
  }): Promise<
    | { valid: true; userId: string }
    | { valid: false; reason: 'expired' | 'tampered' | 'malformed' }
  > {
    const { userId, token, expiry } = args;

    // Up-front malformed checks before touching the DB.
    if (typeof userId !== 'string' || userId.length === 0) {
      return { valid: false, reason: 'malformed' };
    }
    if (typeof token !== 'string') {
      return { valid: false, reason: 'malformed' };
    }
    if (
      typeof expiry !== 'number' ||
      !Number.isFinite(expiry) ||
      !Number.isInteger(expiry) ||
      expiry <= 0
    ) {
      return { valid: false, reason: 'malformed' };
    }

    // Look up the user's CURRENT emailHash. A missing user / missing email
    // both surface as `tampered` — we do NOT want to leak "user does not
    // exist" via a distinct error code (account enumeration defense).
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'emailHash'],
    });
    if (!user || !user.emailHash) {
      return { valid: false, reason: 'tampered' };
    }

    const bindingId = `${user.id}|${user.emailHash}`;
    // Reuse W93 util — it owns ordering: malformed → expired → tampered.
    const result = verifyActionLinkToken({
      projectId: bindingId,
      token,
      expiry,
    });

    if (result.valid) {
      return { valid: true, userId: user.id };
    }
    return { valid: false, reason: result.reason };
  }

  /**
   * Backend API base URL used to construct the verify link inside the
   * email body. The link points at the BACKEND verify endpoint, which then
   * 302-redirects to the frontend `/profile?verified=...` per spec §3.
   *
   * Precedence:
   *   1. APP_URL  — canonical backend origin (used elsewhere for profile
   *      images, which is the existing convention in this repo).
   *   2. http://localhost:3000 — Nest dev default port.
   */
  private static resolveApiBase(): string {
    const fromEnv = process.env.APP_URL;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
    return 'http://localhost:3000';
  }

  /**
   * Frontend SPA base URL for the post-verify redirect. Mirrors the
   * precedence used by `NotificationsEmailService.signActionLink`.
   */
  static resolveFrontendBase(): string {
    const fromNotify = process.env.NOTIFY_ACTION_LINK_BASE;
    if (typeof fromNotify === 'string' && fromNotify.length > 0)
      return fromNotify;
    const fromExplicit = process.env.FRONTEND_URL;
    if (typeof fromExplicit === 'string' && fromExplicit.length > 0)
      return fromExplicit;
    return 'http://localhost:5173';
  }
}
