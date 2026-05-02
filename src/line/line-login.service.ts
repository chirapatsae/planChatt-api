/**
 * line-login.service.ts — Wave 86 LINE Login OIDC orchestration.
 *
 * Owns three responsibilities:
 *   1. Issue + persist short-lived `(state, nonce, userId)` tuples for
 *      the OAuth initiate step (CSRF defense).
 *   2. Consume + delete a state on callback (single-use; replay safe).
 *   3. Run the OAuth code-exchange + ID-token verify + binding upsert
 *      atomically inside a transaction.
 *
 * CLAUDE.md references:
 *   - §1 user classification + §2 work-status — re-checked on link.
 *     Only an `approved` workStatus may complete the binding.
 *   - §17.3 Audit separation — binding mutation NEVER touches
 *     TrackingStatus. We write to `line_user_bindings` only.
 *   - §17.11 No role exemption — binding ownership is integrity, not
 *     permission. Re-binding rules apply uniformly to all roles.
 *   - W86 discovery §J — code/token/id_token bodies MUST NEVER appear
 *     in logs. We log structured outcomes only.
 *
 * State-store note (TBD-FOR-PRODUCTION):
 *   The in-memory `Map` is fine for single-process dev and the current
 *   pilot deployment scale. For horizontal scaling (multiple Node
 *   replicas behind a load-balancer with sticky-session-off), this
 *   MUST migrate to Redis or a DB-backed store. The TTL is enforced
 *   by a setInterval sweep + per-read expiry check.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { LineUserBinding } from './entities/line-user-binding.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  assertLineLoginConfig,
  LINE_LOGIN_AUTHORIZE_URL,
  LINE_LOGIN_TOKEN_URL,
  LINE_LOGIN_PROFILE_URL,
  LineLoginConfig,
} from './line.config';
import {
  InvalidLineIdTokenError,
  LineJwksService,
  VerifiedLineIdTokenClaims,
} from './line-jwks.service';

const STATE_TTL_MS = 15 * 60 * 1000; // 15 min — matches task spec
const STATE_CLEANUP_INTERVAL_MS = 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 5_000;

interface StateEntry {
  userId: string;
  nonce: string;
  expiresAt: number;
}

export interface LineLoginCallbackResult {
  ok: boolean;
  userId?: string;
  // Reason short-code used in error redirect URL — see callback handler.
  reason?: string;
}

/**
 * W96B — thrown by `upsertBinding` when the incoming `lineUserId` already has
 * an active binding owned by a DIFFERENT Project Bank user. The previous
 * implementation silently soft-unlinked the other user's binding; that was a
 * privacy / UX defect (the displaced user lost notifications without notice).
 *
 * The new contract: cross-binding is REJECTED. Frontend surfaces a Thai
 * toast asking the user to unlink the previous account first. Same-user
 * re-link (rebinding your OWN LINE) continues to succeed.
 */
export class LineCrossBindingError extends Error {
  constructor() {
    super('LINE_CROSS_BINDING_REJECTED');
    this.name = 'LineCrossBindingError';
  }
}

@Injectable()
export class LineLoginService implements OnModuleDestroy {
  private readonly logger = new Logger(LineLoginService.name);
  private readonly stateStore = new Map<string, StateEntry>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    @InjectRepository(LineUserBinding)
    private readonly bindingRepo: Repository<LineUserBinding>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    private readonly dataSource: DataSource,
    private readonly jwks: LineJwksService,
  ) {
    this.sweepTimer = setInterval(
      () => this.sweepExpiredStates(),
      STATE_CLEANUP_INTERVAL_MS,
    );
    // Allow process exit without waiting for this timer.
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
    this.stateStore.clear();
  }

  // ---------------------------------------------------------------------
  // INITIATE — build authorize URL + persist state
  // ---------------------------------------------------------------------

  /**
   * Build the LINE OAuth authorize URL for `userId` and persist the
   * state/nonce envelope in the in-memory store. Caller (controller)
   * MUST have already enforced JWT auth + workStatus = approved.
   */
  initiate(userId: string): { authorizeUrl: string } {
    const cfg = assertLineLoginConfig();

    const state = this.randomToken(32);
    const nonce = this.randomToken(32);

    this.stateStore.set(state, {
      userId,
      nonce,
      expiresAt: Date.now() + STATE_TTL_MS,
    });

    const url = new URL(LINE_LOGIN_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', cfg.channelId);
    url.searchParams.set('redirect_uri', cfg.callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('scope', 'openid profile');

    this.logger.log(
      `line-login.initiate userId=${userId} at=${new Date().toISOString()}`,
    );

    return { authorizeUrl: url.toString() };
  }

  // ---------------------------------------------------------------------
  // CALLBACK — code exchange, ID token verify, binding upsert
  // ---------------------------------------------------------------------

  /**
   * Process the callback from LINE. Returns a structured outcome that
   * the controller maps to a 302 redirect.
   *
   * Failure-mode policy:
   *   - state unknown / expired → reason=state_invalid
   *   - LINE returned ?error=... → reason=user_denied (or LINE-supplied)
   *   - code exchange failure   → reason=code_exchange_failed
   *   - id_token verify failure → reason=token_invalid (sub-reason logged)
   *   - workStatus ≠ approved   → reason=work_status_not_approved
   *   - cross-binding conflict  → reason=already_linked
   *
   * No internal error message is leaked to the user-visible URL.
   */
  async handleCallback(args: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<LineLoginCallbackResult> {
    const cfg = assertLineLoginConfig();

    if (args.error) {
      this.logger.warn(
        `line-login.callback.failure reason=user_denied at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'user_denied' };
    }

    if (!args.state || typeof args.state !== 'string') {
      this.logger.warn(
        `line-login.callback.failure reason=state_missing at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'state_invalid' };
    }
    if (!args.code || typeof args.code !== 'string') {
      this.logger.warn(
        `line-login.callback.failure reason=code_missing at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'code_invalid' };
    }

    // Single-use state consumption (atomic delete inside Map).
    const stateEntry = this.stateStore.get(args.state);
    if (!stateEntry) {
      this.logger.warn(
        `line-login.callback.failure reason=state_unknown at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'state_invalid' };
    }
    this.stateStore.delete(args.state);
    if (Date.now() > stateEntry.expiresAt) {
      this.logger.warn(
        `line-login.callback.failure reason=state_expired at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'state_invalid' };
    }
    const { userId, nonce } = stateEntry;

    // Re-check workStatus = approved at link-completion time
    // (CLAUDE.md §1 + §2; the workStatus could have changed between
    // initiate and callback). We sort by createdAt DESC and pick the
    // first row — this matches the AuthService.handleOAuthLogin
    // pattern used elsewhere in the codebase. `isCurrent = true` would
    // be a stricter filter but the existing OAuth path does not enforce
    // it either, so we stay consistent.
    const wh = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'user'],
      order: { createdAt: 'DESC' },
    });
    if (!wh || wh.workStatus?.name !== 'approved') {
      this.logger.warn(
        `line-login.callback.failure reason=work_status_not_approved userId=${userId} at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'work_status_not_approved' };
    }

    // Exchange the authorization code for tokens.
    let tokenResp: { id_token: string; access_token?: string };
    try {
      tokenResp = await this.exchangeCode(args.code, cfg);
    } catch (e: any) {
      this.logger.warn(
        `line-login.callback.failure reason=code_exchange_failed at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'code_exchange_failed' };
    }

    // Verify ID token (sig + iss + aud + exp + nonce).
    let claims: VerifiedLineIdTokenClaims;
    try {
      claims = await this.jwks.verifyIdToken(tokenResp.id_token, nonce);
    } catch (e: any) {
      const subReason =
        e instanceof InvalidLineIdTokenError ? e.reason : 'verify_failed';
      this.logger.warn(
        `line-login.callback.failure reason=token_invalid sub=${subReason} at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'token_invalid' };
    }

    // Optional profile fetch when name/picture aren't in the ID token.
    let displayName: string | null = claims.name ?? null;
    let pictureUrl: string | null = claims.picture ?? null;
    if ((!displayName || !pictureUrl) && tokenResp.access_token) {
      try {
        const profile = await this.fetchProfile(tokenResp.access_token);
        if (profile) {
          if (!displayName && profile.displayName) {
            displayName = profile.displayName;
          }
          if (!pictureUrl && profile.pictureUrl) {
            pictureUrl = profile.pictureUrl;
          }
        }
      } catch {
        // Profile fetch is best-effort — proceed without it.
      }
    }

    // Upsert the binding inside a transaction.
    try {
      await this.upsertBinding({
        userId,
        lineUserId: claims.sub,
        displayName,
        pictureUrl,
      });
    } catch (e: any) {
      // W96B — distinguish cross-binding rejection from other failures so
      // the FE can show a precise "ask the other user to unlink first"
      // toast instead of a generic "binding failed".
      if (e instanceof LineCrossBindingError) {
        this.logger.warn(
          `line-login.callback.failure reason=already_linked userId=${userId} at=${new Date().toISOString()}`,
        );
        return { ok: false, reason: 'already_linked' };
      }
      this.logger.warn(
        `line-login.callback.failure reason=binding_failed at=${new Date().toISOString()}`,
      );
      return { ok: false, reason: 'binding_failed' };
    }

    this.logger.log(
      `line-login.callback.success userId=${userId} lineUserId=${this.shaPrefix(claims.sub)} at=${new Date().toISOString()}`,
    );
    this.logger.log(
      `line-login.binding.upserted userId=${userId} at=${new Date().toISOString()}`,
    );

    return { ok: true, userId };
  }

  // ---------------------------------------------------------------------
  // STATUS — read-only lookup of active binding for current user
  // ---------------------------------------------------------------------

  /**
   * Return the active binding (if any) for `userId`. The active binding
   * is the row where `unlinkedAt IS NULL` (per §17.3 soft-unlink model;
   * historical rows are preserved for audit and are explicitly excluded
   * here).
   *
   * Privacy: `lineUserId` is returned to the caller because the FE needs
   * a stable identity label. The FE is responsible for any presentation
   * redaction (e.g. showing only the first few chars). We log only a
   * boolean `linked` flag — never the lineUserId itself (W83 / §17.10).
   *
   * `basicId` is not stored on the binding row today; it is left
   * undefined here so the FE can degrade gracefully when absent.
   */
  async getLinkStatus(userId: string): Promise<{
    linked: boolean;
    lineUserId?: string;
    displayName?: string;
    pictureUrl?: string;
    linkedAt?: string;
    basicId?: string;
  }> {
    const binding = await this.bindingRepo.findOne({
      where: { userId, unlinkedAt: IsNull() },
    });

    if (!binding) {
      this.logger.log(
        `line-login.status.queried userId=${userId} linked=false at=${new Date().toISOString()}`,
      );
      return { linked: false };
    }

    this.logger.log(
      `line-login.status.queried userId=${userId} linked=true at=${new Date().toISOString()}`,
    );

    return {
      linked: true,
      lineUserId: binding.lineUserId,
      displayName: binding.displayName ?? undefined,
      pictureUrl: binding.pictureUrl ?? undefined,
      linkedAt: binding.linkedAt?.toISOString(),
      // basicId not stored today — FE degrades gracefully when absent.
    };
  }

  // ---------------------------------------------------------------------
  // UNLINK — soft-unlink the active binding for current user
  // ---------------------------------------------------------------------

  /**
   * Soft-unlink the active binding (if any) for `userId`. Idempotent —
   * if no active binding exists, returns `{ unlinked: false }` without
   * error. Per §17.3 we MUST NOT hard-delete: setting `unlinkedAt` to
   * the current timestamp preserves the audit trail and allows the
   * partial-unique index on `(line_user_id) WHERE unlinked_at IS NULL`
   * to release the LINE id for future re-link.
   */
  async unlink(userId: string): Promise<{ unlinked: boolean }> {
    const now = new Date();
    const result = await this.bindingRepo.update(
      { userId, unlinkedAt: IsNull() },
      { unlinkedAt: now },
    );

    const affected = result.affected ?? 0;
    const unlinked = affected > 0;

    this.logger.log(
      `line-login.unlink userId=${userId} at=${now.toISOString()}`,
    );

    return { unlinked };
  }

  // ---------------------------------------------------------------------
  // Internal — code exchange
  // ---------------------------------------------------------------------

  private async exchangeCode(
    code: string,
    cfg: LineLoginConfig,
  ): Promise<{ id_token: string; access_token?: string }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', cfg.callbackUrl);
    body.set('client_id', cfg.channelId);
    body.set('client_secret', cfg.channelSecret);

    try {
      const res = await fetch(LINE_LOGIN_TOKEN_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });

      if (!res.ok) {
        throw new Error(`token endpoint HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        id_token?: string;
        access_token?: string;
      };
      if (!json.id_token || typeof json.id_token !== 'string') {
        throw new Error('id_token missing in token response');
      }
      return { id_token: json.id_token, access_token: json.access_token };
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchProfile(
    accessToken: string,
  ): Promise<{ displayName?: string; pictureUrl?: string } | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
    try {
      const res = await fetch(LINE_LOGIN_PROFILE_URL, {
        method: 'GET',
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        displayName?: string;
        pictureUrl?: string;
      };
      return {
        displayName:
          typeof json.displayName === 'string' ? json.displayName : undefined,
        pictureUrl:
          typeof json.pictureUrl === 'string' ? json.pictureUrl : undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------
  // Internal — binding upsert
  // ---------------------------------------------------------------------

  private async upsertBinding(args: {
    userId: string;
    lineUserId: string;
    displayName: string | null;
    pictureUrl: string | null;
  }): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(LineUserBinding);
      const now = new Date();

      // W96B — REJECT cross-binding before mutating anything. If this
      // lineUserId already has an active binding owned by a different
      // Project Bank user, we MUST NOT silently soft-unlink it (the
      // displaced user would lose notifications without notice). Force
      // the new user to ask the previous owner to unlink first.
      //
      // Same-user re-link (your OWN LINE) is fine — handled by the
      // soft-unlink-self step below.
      const conflictRow = await repo.findOne({
        where: {
          lineUserId: args.lineUserId,
          unlinkedAt: IsNull(),
        },
      });
      if (conflictRow && conflictRow.userId !== args.userId) {
        // W83 — never log raw lineUserId; SHA-256 prefix only.
        this.logger.warn(
          `line-login.binding.cross-binding-rejected ` +
            `incomingUserId=${args.userId} ` +
            `incumbentUserId=${conflictRow.userId} ` +
            `lineUserIdHash=${this.shaPrefix(args.lineUserId)} ` +
            `at=${now.toISOString()}`,
        );
        throw new LineCrossBindingError();
      }

      // Soft-unlink any active binding owned by this user (re-link self).
      await repo.update(
        { userId: args.userId, unlinkedAt: IsNull() },
        { unlinkedAt: now },
      );

      // Insert the new active binding.
      const fresh = repo.create({
        userId: args.userId,
        lineUserId: args.lineUserId,
        displayName: args.displayName,
        pictureUrl: args.pictureUrl,
        unlinkedAt: null,
        lastSeenAt: null,
      });
      await repo.save(fresh);
    });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private randomToken(byteLen: number): string {
    return crypto.randomBytes(byteLen).toString('base64url');
  }

  private sweepExpiredStates(): void {
    const now = Date.now();
    for (const [state, entry] of this.stateStore.entries()) {
      if (now > entry.expiresAt) {
        this.stateStore.delete(state);
      }
    }
  }

  /** SHA-256 hex prefix (12 chars) for log diagnostics — never logs raw lineUserId. */
  private shaPrefix(s: string): string {
    return crypto
      .createHash('sha256')
      .update(s)
      .digest('hex')
      .slice(0, 12);
  }
}
