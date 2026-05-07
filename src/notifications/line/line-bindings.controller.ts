import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { ADMIN_OR_ABOVE } from 'src/auth/role-groups';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { LineBindingAdminAction } from './entities/line-binding-admin-action.entity';
import { ListLineBindingsQueryDto } from './dto/list-line-bindings.dto';
import { RevealLineBindingBodyDto } from './dto/reveal-line-binding.dto';

/**
 * W97-API-BINDINGS — LINE binding registry endpoints.
 *
 * Source of truth:
 *   - docs/tasks/wave97/W97-API-BINDINGS.md
 *   - W97-INVESTIGATE fact sheet
 *   - W97-MIGRATION (`line_binding_admin_actions` table)
 *
 * Endpoints (admin + super-admin per W97 user-amendment; user role returns 403):
 *
 *   GET  /v1/admin/notifications/line-bindings
 *     Paginated, filterable list with masked `lineUserId` and masked
 *     email. Search matches user firstname / lastname / email_hash —
 *     NEVER `lineUserId` (Q9 PII reverse-lookup vector).
 *
 *   POST /v1/admin/notifications/line-bindings/:id/reveal
 *     Returns the unmasked `lineUserId` for a single binding and writes
 *     a `line_binding_admin_actions` audit row in the same transaction.
 *     Rate-limited to 30 reveals per actor per rolling 60-minute window
 *     (defense vs sweep harvesting; W97-API-BINDINGS §9).
 *
 * CLAUDE.md guardrails:
 *   - §4.1  — these endpoints expose central-authority operational data;
 *             they do NOT gate any workflow transition.
 *   - §12   — neither endpoint writes to `tracking_status`.
 *   - §17.3 — the audit row goes into `line_binding_admin_actions`;
 *             that table has NO FK into project tables.
 *   - §17.11 — even super-admin reveals flow through the audit row;
 *              no permission-bypass path exists.
 *   - W83   — server logs MUST mask `lineUserId` via `shortHash`. The
 *             reveal RESPONSE returns the unmasked id (intentional —
 *             that is the point of the endpoint), but server logs MUST
 *             NEVER print it in plaintext.
 */

// W97 user-amendment: list (GET) + reveal (POST) become accessible to admin
// in addition to super-admin. Force-unlink stays super-admin-only because it
// terminates user consent — central authority only.
/** 30 reveals per actor per rolling 60-minute window. */
const REVEAL_WINDOW_MS = 60 * 60 * 1000;
const REVEAL_MAX_PER_WINDOW = 30;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

@Controller({
  path: 'admin/notifications/line-bindings',
  version: '1',
})
export class LineBindingsController {
  private readonly logger = new Logger(LineBindingsController.name);

  /**
   * Per-actor rolling-window counter for the reveal endpoint. Sliding
   * window — each entry is the list of epoch-ms timestamps of the actor's
   * successful reveal calls within the past `REVEAL_WINDOW_MS`. Older
   * timestamps are evicted lazily on each call.
   *
   * NOT a replacement for a proper distributed rate-limiter — multi-
   * instance deploys can race past this. Acceptable: reveal is a low-
   * volume, audited path; the audit row is the source of truth, and
   * §17.11 forbids any super-admin from coercing past the cap on a
   * single instance anyway.
   */
  private readonly revealWindow = new Map<string, number[]>();

  constructor(
    @InjectRepository(LineUserBinding)
    private readonly bindingRepo: Repository<LineUserBinding>,
    @InjectRepository(LineBindingAdminAction)
    private readonly auditRepo: Repository<LineBindingAdminAction>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /v1/admin/notifications/line-bindings
  // ---------------------------------------------------------------------------

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_OR_ABOVE)
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() query: ListLineBindingsQueryDto,
  ): Promise<{
    items: Array<{
      id: string;
      userId: string;
      userFullName: string;
      userEmailMasked: string;
      lineDisplayName: string | null;
      lineUserIdMasked: string;
      linkedAt: string;
      unlinkedAt: string | null;
      botFriendState: 'unknown' | 'friend' | 'unfriend' | 'blocked';
      hasInflightUnlink: boolean;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const status = query.status ?? 'active';
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE),
    );

    // Build the filtered + searched query. LEFT JOIN `users` and filter
    // `users.id IS NOT NULL` to drop orphan bindings whose user was
    // hard-deleted (W97-API-BINDINGS §11). Soft-deleted users (`deleted_at
    // IS NOT NULL`) are also excluded by default.
    const qb = this.bindingRepo
      .createQueryBuilder('b')
      .innerJoin(User, 'u', 'u.id = b.user_id AND u.delete_at IS NULL');

    if (status === 'active') {
      qb.andWhere('b.unlinked_at IS NULL');
    } else if (status === 'unlinked') {
      qb.andWhere('b.unlinked_at IS NOT NULL');
    }
    // status === 'all' adds no filter on unlinked_at.

    if (query.userId) {
      qb.andWhere('b.user_id = :uid', { uid: query.userId });
    }

    if (query.q && query.q.trim().length > 0) {
      const needle = `%${query.q.trim()}%`;
      // Q9 — search is firstname/lastname ONLY. We intentionally do NOT
      // search by raw `lineUserId` (PII reverse-lookup vector) and do
      // NOT search the encrypted-at-rest `email` column (W89 — ciphertext
      // never matches plaintext substring).
      qb.andWhere('(u.firstname ILIKE :q OR u.lastname ILIKE :q)', {
        q: needle,
      });
    }

    qb.orderBy('b.linked_at', 'DESC').addOrderBy('b.id', 'ASC');

    // Count BEFORE applying skip/take so the pager has the global total.
    const total = await qb.getCount();

    qb.select('b.id', 'id')
      .addSelect('b.user_id', 'user_id')
      .addSelect('b.line_user_id', 'line_user_id')
      .addSelect('b.display_name', 'display_name')
      .addSelect('b.linked_at', 'linked_at')
      .addSelect('b.unlinked_at', 'unlinked_at')
      .addSelect('u.firstname', 'firstname')
      .addSelect('u.lastname', 'lastname')
      .addSelect('u.email', 'email')
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    const rows: Array<{
      id: string;
      user_id: string;
      line_user_id: string;
      display_name: string | null;
      linked_at: Date;
      unlinked_at: Date | null;
      firstname: string | null;
      lastname: string | null;
      email: string | null;
    }> = await qb.getRawMany();

    const items = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userFullName: this.buildFullName(r.firstname, r.lastname),
      // `email` is encrypted at rest (W89). We intentionally do NOT
      // decrypt for the listing; `maskEmail` over ciphertext returns
      // `***` shape, which is the desired non-disclosing behavior.
      // Reveal of email is out of scope for this endpoint — only
      // `lineUserId` is revealable, via the dedicated reveal endpoint.
      userEmailMasked: this.maskEmailLike(r.email),
      lineDisplayName: r.display_name,
      lineUserIdMasked: this.maskLineUserId(r.line_user_id),
      linkedAt:
        r.linked_at instanceof Date
          ? r.linked_at.toISOString()
          : new Date(r.linked_at).toISOString(),
      unlinkedAt:
        r.unlinked_at == null
          ? null
          : r.unlinked_at instanceof Date
            ? r.unlinked_at.toISOString()
            : new Date(r.unlinked_at).toISOString(),
      // Default to 'unknown' — bot-friend state is not tracked on
      // `line_user_bindings` today (W86 schema). When/if a future wave
      // adds a column, this controller can read it without a contract
      // change.
      botFriendState: 'unknown' as const,
      // Force-unlink in-flight tracking is owned by W97-API-FORCE-UNLINK.
      // Default false here keeps the FE contract stable.
      hasInflightUnlink: false,
    }));

    return { items, total, page, pageSize };
  }

  // ---------------------------------------------------------------------------
  // POST /v1/admin/notifications/line-bindings/:id/reveal
  // ---------------------------------------------------------------------------

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_OR_ABOVE)
  @Post(':id/reveal')
  @HttpCode(HttpStatus.OK)
  async reveal(
    @Req() req: Request & { user: JwtPayloadUser },
    @Param('id', new ParseUUIDPipe()) bindingId: string,
    @Body() body: RevealLineBindingBodyDto,
  ): Promise<{
    id: string;
    lineUserId: string;
    lineDisplayName: string | null;
    linkedAt: string;
    unlinkedAt: string | null;
    revealAuditId: string;
  }> {
    this.assertRevealRateLimit(req.user.userId);

    // Resolve actor's current WorkHistory for audit context (CLAUDE.md §4
    // ownership-via-WorkHistory pattern). NULL-tolerant: actor may not
    // have a current WorkHistory in degraded data states; the audit row
    // accepts NULL there.
    const actorWorkHistoryId = await this.resolveCurrentWorkHistoryId(
      req.user.userId,
    );

    // Read binding row first (outside the txn) so a 404 short-circuits
    // before we open a transaction. Read again inside the txn to avoid
    // TOCTOU on the unlink state.
    const probe = await this.bindingRepo.findOne({
      where: { id: bindingId },
      select: ['id'],
    });
    if (!probe) {
      throw new NotFoundException('LINE binding ไม่พบ');
    }

    // Capture transport metadata for the audit row.
    const requestIp = this.extractRequestIp(req);
    const requestUserAgent = this.extractUserAgent(req);

    const { binding, auditId } = await this.dataSource.transaction(
      async (manager) => {
        const txnBindingRepo = manager.getRepository(LineUserBinding);
        const txnAuditRepo = manager.getRepository(LineBindingAdminAction);

        const row = await txnBindingRepo.findOne({
          where: { id: bindingId },
        });
        if (!row) {
          throw new NotFoundException('LINE binding ไม่พบ');
        }

        // Insert audit FIRST in the same txn so the read is auditable
        // even if a downstream failure rolls back (which would also roll
        // back the audit, keeping invariants). Returning the inserted id
        // lets the FE link the reveal call to its audit row for support
        // workflows.
        const insertResult = await txnAuditRepo.insert({
          action: 'reveal',
          actorUserId: req.user.userId,
          actorWorkHistoryId,
          targetBindingId: row.id,
          targetUserId: row.userId,
          // `purpose` is persisted in `reason`; the DB CHECK only enforces
          // length on the force-unlink branch, so the application layer
          // length-validates `purpose` (12..200) at the DTO layer.
          reason: body.purpose,
          requestIp,
          requestUserAgent,
        });
        const insertedId = (insertResult.identifiers?.[0]?.id ?? null) as
          | string
          | null;

        return { binding: row, auditId: insertedId };
      },
    );

    // Arm rate-limit window only on a successful reveal (failed paths
    // throw above before reaching this point).
    this.armRevealRateLimit(req.user.userId);

    // W83 — log line uses the shortHash mask, NEVER the raw lineUserId.
    // The unmasked value is returned in the response body (intentional
    // surface of the reveal endpoint), but never written to a log line.
    // QA H1 fix: replaced raw `console.log` with NestJS Logger to comply
    // with the "no `console.log` in W97 production paths" QA rule.
    this.logger.log(
      `[LineBindingReveal] actor=${req.user.userId} binding=${binding.id} target=${this.shortHash(binding.lineUserId)} auditId=${auditId ?? '<unknown>'}`,
    );

    return {
      id: binding.id,
      lineUserId: binding.lineUserId,
      lineDisplayName: binding.displayName,
      linkedAt:
        binding.linkedAt instanceof Date
          ? binding.linkedAt.toISOString()
          : new Date(binding.linkedAt).toISOString(),
      unlinkedAt:
        binding.unlinkedAt == null
          ? null
          : binding.unlinkedAt instanceof Date
            ? binding.unlinkedAt.toISOString()
            : new Date(binding.unlinkedAt).toISOString(),
      revealAuditId: auditId ?? '',
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Sliding-window rate limit: at most `REVEAL_MAX_PER_WINDOW`
   * successful reveals per actor per `REVEAL_WINDOW_MS`.
   *
   * Throws `429` with structured body when the cap is exceeded. Does
   * NOT arm the window — that happens in `armRevealRateLimit` after a
   * successful reveal so failed attempts do not consume budget.
   */
  private assertRevealRateLimit(actorId: string): void {
    const now = Date.now();
    const windowStart = now - REVEAL_WINDOW_MS;

    const list = this.revealWindow.get(actorId) ?? [];
    // Evict timestamps older than the window.
    const live = list.filter((ts) => ts >= windowStart);
    if (live.length !== list.length) {
      this.revealWindow.set(actorId, live);
    }

    if (live.length >= REVEAL_MAX_PER_WINDOW) {
      const earliest = live[0];
      const retryAfterMs = Math.max(0, REVEAL_WINDOW_MS - (now - earliest));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'เรียกการเปิดเผยข้อมูล LINE userId เกินขีดจำกัด กรุณาลองใหม่ในภายหลัง',
          retryAfterMs,
          windowMs: REVEAL_WINDOW_MS,
          maxPerWindow: REVEAL_MAX_PER_WINDOW,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private armRevealRateLimit(actorId: string): void {
    const now = Date.now();
    const list = this.revealWindow.get(actorId) ?? [];
    list.push(now);
    this.revealWindow.set(actorId, list);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * W97-API-BINDINGS §7 mask format:
   *   - 33-char `lineUserId` (typical) → first 5 + `****` + last 4
   *   - Defensive: short / non-string inputs collapse to `***`.
   *
   * Example: `U1a2b3c4d5e6f...XXXX` → `U1a2b****wxyz` (9 visible + 4 stars).
   */
  private maskLineUserId(value: string | null | undefined): string {
    if (!value || typeof value !== 'string') return '***';
    if (value.length < 9) return '***';
    return `${value.slice(0, 5)}****${value.slice(-4)}`;
  }

  /**
   * Email masking that survives ciphertext input. The `users.email`
   * column is encrypted at rest (W89 — `iv:ciphertext` shape with no
   * `@`). For ciphertext we MUST return a non-revealing placeholder
   * rather than leak the encoded blob.
   */
  private maskEmailLike(email: string | null | undefined): string {
    if (!email || typeof email !== 'string') return '***';
    if (!email.includes('@')) return '***';
    const [local, domain] = email.split('@');
    if (!local || local.length <= 1) return `***@${domain}`;
    return `${local[0]}***@${domain}`;
  }

  /**
   * SHA-256 first 8 hex chars + ellipsis — W83 log mask. Mirrors the
   * `shortHash` helper inside `LineMessagingService` /
   * `NotificationsLineController` so log shapes are consistent across
   * the codebase.
   */
  private shortHash(value: string): string {
    if (!value) return '<empty>';
    return (
      crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex')
        .slice(0, 8) + '...'
    );
  }

  private buildFullName(
    firstname: string | null,
    lastname: string | null,
  ): string {
    const f = (firstname ?? '').trim();
    const l = (lastname ?? '').trim();
    const joined = `${f} ${l}`.trim();
    return joined.length > 0 ? joined : '—';
  }

  private async resolveCurrentWorkHistoryId(
    userId: string,
  ): Promise<string | null> {
    try {
      const wh = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true, deletedAt: IsNull() },
        select: ['id'],
      });
      if (wh?.id) return wh.id;
      // Fallback: most recently-updated history row.
      const fallback = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, deletedAt: IsNull() },
        order: { updatedAt: 'DESC' },
        select: ['id'],
      });
      return fallback?.id ?? null;
    } catch {
      // Audit must succeed even if WorkHistory resolution fails — the
      // column is nullable for exactly this reason.
      return null;
    }
  }

  private extractRequestIp(req: Request): string | null {
    // `req.ip` honors `trust proxy` if configured; fall back to the raw
    // socket address. We intentionally do NOT parse `x-forwarded-for`
    // headers here — that is the platform's responsibility.
    const candidate =
      (req as unknown as { ip?: string }).ip ??
      req.socket?.remoteAddress ??
      null;
    if (!candidate || typeof candidate !== 'string') return null;
    // Postgres `inet` accepts both v4 and v6; strip the IPv4-mapped IPv6
    // prefix so dashboard rendering stays consistent.
    if (candidate.startsWith('::ffff:')) {
      return candidate.slice('::ffff:'.length);
    }
    return candidate;
  }

  private extractUserAgent(req: Request): string | null {
    const ua = req.headers['user-agent'];
    if (typeof ua !== 'string' || ua.length === 0) return null;
    // Defensive cap — `request_user_agent` is `text` in PG so unbounded,
    // but keep the column from accumulating multi-KB payloads.
    return ua.length > 512 ? ua.slice(0, 512) : ua;
  }
}
