import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationSetting } from '../entities/notification-settings.entity';
import { NotificationSettingsAudit } from '../entities/notification-settings-audit.entity';

/**
 * Singleton key for the global kill-switch row. D1 migration seeds exactly
 * one row with this id and `email_enabled=false`. The schema leaves room
 * (varchar(32)) for future per-scope settings without a schema change, but
 * this wave hard-codes a single `global` row.
 */
const GLOBAL_SETTING_ID = 'global';

/** In-process cache TTL for `isEmailEnabled()` / `isLineEnabled()`. */
const CACHE_TTL_MS = 5_000;

/** Cache TTL surfaced to the FE in the GET/PATCH response. */
const CACHE_TTL_SECONDS = 5;

/** Per-channel discriminator written to `notification_settings_audit.channel`. */
type AuditChannel = 'email' | 'line';

/**
 * Compact projection of a single audit row for the dashboard.
 * `actorEmailMasked` is masked here (e.g. `j***n@example.com`) — no W83 PII.
 */
export interface SettingsAuditView {
  actorFullName: string | null;
  actorEmailMasked: string | null;
  action: 'enable' | 'disable';
  reason: string | null;
  createdAt: Date;
}

/**
 * Wave 97 read/write response envelope. Mirrors the W97-API-KILL-SWITCH-EXTEND
 * task spec §3 GET shape. The PATCH endpoint returns the same shape with
 * the new `updatedAt` token.
 */
export interface SettingsView {
  emailEnabled: boolean;
  lineEnabled: boolean;
  /** ISO timestamp — used as optimistic-concurrency token by the FE. */
  updatedAt: string;
  lastEmailAudit: SettingsAuditView | null;
  lastLineAudit: SettingsAuditView | null;
  cacheTtlSeconds: number;
}

/**
 * Backward-compat alias kept for any pre-W97 import sites. New code SHOULD
 * import `SettingsView`. The two are identical — see W97 envelope notes.
 */
export type EmailSettingsView = SettingsView;

/**
 * Wave 22 B2 / Wave 97 — global notification kill-switch service.
 *
 * Source of truth:
 *   - docs/tasks/wave97/W97-API-KILL-SWITCH-EXTEND.md
 *   - Entities: NotificationSetting + NotificationSettingsAudit
 *   - CLAUDE.md §4.1 (kill-switch OFF MUST NOT fail any workflow transition)
 *   - CLAUDE.md §12   (audit writes land in `notification_settings_audit`,
 *                      NEVER in `tracking_status`)
 *   - CLAUDE.md §17.11 (no role exemption — kill-switch is integrity-neutral)
 *
 * Wave 97 extensions:
 *   - Per-channel kill-switch: independent `emailEnabled` and `lineEnabled`
 *     flags toggled via the same PATCH. One PATCH that flips both flags
 *     writes TWO audit rows (channel='email' and channel='line').
 *   - Optimistic locking via `expectedUpdatedAt` body field. Mismatch with
 *     row's current `updated_at` → 409 SETTINGS_STALE.
 *   - Reason required (12..200 chars) when at least one flag transitions
 *     ON→OFF. Reason optional for OFF→ON.
 *   - Idempotent: a PATCH that applies no actual change writes ZERO audit
 *     rows and returns 200 with the current state.
 *
 * Guarantees:
 *   - `isEmailEnabled()` / `isLineEnabled()` are fail-closed.
 *   - In-process 5-second TTL cache with write-through invalidation.
 *   - Every state change writes exactly one audit row PER CHANGED FLAG.
 *   - Settings UPDATE + audit INSERT(s) happen in a single transaction.
 */
@Injectable()
export class NotificationSettingsService {
  private readonly logger = new Logger(NotificationSettingsService.name);

  /** Cached `emailEnabled` value with fetch timestamp. */
  private cache: { value: boolean; fetchedAt: number } | null = null;

  /**
   * Wave 96 — separate cache slot for `lineEnabled`. Distinct from the
   * email cache so a flip on one channel does not invalidate the other.
   */
  private lineCache: { value: boolean; fetchedAt: number } | null = null;

  constructor(
    @InjectRepository(NotificationSetting)
    private readonly settingsRepo: Repository<NotificationSetting>,
    @InjectRepository(NotificationSettingsAudit)
    private readonly auditRepo: Repository<NotificationSettingsAudit>,
  ) {}

  /**
   * Fast gate used by `NotificationsEmailService.queueEmail` as the very
   * first check. Returns the cached `emailEnabled` flag when fresh, falls
   * through to the DB otherwise.
   *
   * Fail-closed: if the DB read throws (connection error, migration
   * pending, etc.) we log a warning and return `false`.
   */
  async isEmailEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.value;
    }

    try {
      const row = await this.settingsRepo.findOne({
        where: { id: GLOBAL_SETTING_ID },
        select: ['id', 'emailEnabled'],
      });
      const value = row?.emailEnabled === true;
      this.cache = { value, fetchedAt: now };
      return value;
    } catch (err) {
      this.logger.warn(
        `[Notify kill-switch] cache-fallback: assuming OFF due to DB error: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Wave 96 — fast gate for the LINE channel. Mirror of `isEmailEnabled`
   * with an independent cache slot.
   */
  async isLineEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.lineCache && now - this.lineCache.fetchedAt < CACHE_TTL_MS) {
      return this.lineCache.value;
    }

    try {
      const row = await this.settingsRepo.findOne({
        where: { id: GLOBAL_SETTING_ID },
        select: ['id', 'lineEnabled'],
      });
      const value = row?.lineEnabled === true;
      this.lineCache = { value, fetchedAt: now };
      return value;
    } catch (err) {
      this.logger.warn(
        `[Notify line kill-switch] cache-fallback: assuming OFF due to DB error: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Load the full settings row for the GET endpoint. Wave 97: now also
   * loads the latest audit row for each channel so the dashboard can
   * render per-channel "last changed" provenance.
   */
  async getSettings(): Promise<SettingsView> {
    const row = await this.settingsRepo.findOne({
      where: { id: GLOBAL_SETTING_ID },
    });
    if (!row) {
      throw new NotFoundException(
        'ไม่พบข้อมูลการตั้งค่าการแจ้งเตือน (seed row missing)',
      );
    }

    const [lastEmailAudit, lastLineAudit] = await Promise.all([
      this.loadLastAudit('email'),
      this.loadLastAudit('line'),
    ]);

    return this.toView(row, lastEmailAudit, lastLineAudit);
  }

  /**
   * Apply a PATCH /admin/email-settings request.
   *
   * Wave 97 contract:
   *   - Body MUST carry at least one of `emailEnabled` / `lineEnabled`.
   *   - `expectedUpdatedAt` (optional but strongly recommended): if
   *     provided, MUST match the row's `updated_at` to the millisecond,
   *     else 409 SETTINGS_STALE.
   *   - For each flag in body, compute the transition against the
   *     row-locked current state. If at least one transition is ON→OFF,
   *     `reason` MUST be present (12..200 chars). Reason is optional when
   *     all transitions are OFF→ON or no-ops.
   *   - Idempotent: when no flag actually changes, returns the current
   *     state and writes ZERO audit rows.
   *   - Transactional: settings UPDATE and per-flag audit INSERT(s) all
   *     happen inside a single FOR UPDATE transaction.
   *   - Cache invalidation is write-through AFTER commit; both
   *     `cache` and `lineCache` are refreshed regardless of which flag(s)
   *     changed (cheap, and avoids stale-read bugs).
   */
  async updateSettings(
    actor: { userId: string; workHistoryId?: string | null },
    body: {
      emailEnabled?: boolean;
      lineEnabled?: boolean;
      reason?: string;
      expectedUpdatedAt?: string;
    },
  ): Promise<SettingsView> {
    if (body.emailEnabled === undefined && body.lineEnabled === undefined) {
      throw new BadRequestException(
        'ต้องระบุอย่างน้อยหนึ่งช่องทาง (emailEnabled หรือ lineEnabled)',
      );
    }

    const manager = this.settingsRepo.manager;
    const result = await manager.transaction(async (tx) => {
      const settingsRepo = tx.getRepository(NotificationSetting);
      const auditRepo = tx.getRepository(NotificationSettingsAudit);

      // Row-lock so two concurrent super-admins cannot race each other.
      const current = await settingsRepo
        .createQueryBuilder('s')
        .setLock('pessimistic_write')
        .where('s.id = :id', { id: GLOBAL_SETTING_ID })
        .getOne();

      if (!current) {
        throw new NotFoundException(
          'ไม่พบข้อมูลการตั้งค่าการแจ้งเตือน (seed row missing)',
        );
      }

      // Optimistic lock — compare ms-precision timestamps. We compare via
      // numeric epoch to dodge ISO string formatting differences (Z vs
      // +00:00, trailing zeros, etc.).
      if (body.expectedUpdatedAt !== undefined) {
        const expected = Date.parse(body.expectedUpdatedAt);
        const currentTs = current.updatedAt
          ? new Date(current.updatedAt).getTime()
          : NaN;
        if (
          Number.isNaN(expected) ||
          Number.isNaN(currentTs) ||
          expected !== currentTs
        ) {
          throw new ConflictException({
            statusCode: 409,
            error: 'SETTINGS_STALE',
            message: 'การตั้งค่าถูกแก้ไขโดยผู้อื่น โปรดโหลดใหม่ก่อนเปลี่ยนแปลง',
          });
        }
      }

      // Resolve transitions per flag against the locked current state.
      const transitions: Array<{
        channel: AuditChannel;
        prev: boolean;
        next: boolean;
      }> = [];
      if (
        body.emailEnabled !== undefined &&
        body.emailEnabled !== current.emailEnabled
      ) {
        transitions.push({
          channel: 'email',
          prev: current.emailEnabled,
          next: body.emailEnabled,
        });
      }
      if (
        body.lineEnabled !== undefined &&
        body.lineEnabled !== current.lineEnabled
      ) {
        transitions.push({
          channel: 'line',
          prev: current.lineEnabled,
          next: body.lineEnabled,
        });
      }

      // Idempotent short-circuit — no flag actually changes.
      if (transitions.length === 0) {
        const [lastEmailAudit, lastLineAudit] = await Promise.all([
          this.loadLastAuditTx(auditRepo, 'email'),
          this.loadLastAuditTx(auditRepo, 'line'),
        ]);
        return {
          view: this.toView(current, lastEmailAudit, lastLineAudit),
          changedEmail: false,
          changedLine: false,
        };
      }

      // Reason gate: required if ANY transition is ON→OFF (disable).
      const hasDisable = transitions.some((t) => t.prev && !t.next);
      const trimmedReason =
        typeof body.reason === 'string' ? body.reason.trim() : '';
      if (hasDisable && trimmedReason.length === 0) {
        throw new BadRequestException(
          'ต้องระบุเหตุผล (12-200 ตัวอักษร) เมื่อปิดการแจ้งเตือน',
        );
      }
      if (trimmedReason.length > 0) {
        if (trimmedReason.length < 12 || trimmedReason.length > 200) {
          throw new BadRequestException('reason ต้องมีความยาว 12-200 ตัวอักษร');
        }
      }

      // Apply both transitions in a single UPDATE; bump updated_at to NOW().
      const now = new Date();
      for (const t of transitions) {
        if (t.channel === 'email') {
          current.emailEnabled = t.next;
        } else {
          current.lineEnabled = t.next;
        }
      }
      current.lastChangedAt = now;
      current.lastChangedById = actor.userId;
      current.updatedAt = now;
      await settingsRepo.save(current);

      // One audit row per changed flag — channel column is EXPLICIT per
      // W97-MIGRATION (the column has DROP DEFAULT after backfill, so an
      // omitted channel will fail at the DB).
      for (const t of transitions) {
        await auditRepo.insert({
          settingId: GLOBAL_SETTING_ID,
          prevEnabled: t.prev,
          nextEnabled: t.next,
          changedById: actor.userId,
          changedAt: now,
          reason: trimmedReason.length > 0 ? trimmedReason : null,
          channel: t.channel,
        });
      }

      const [lastEmailAudit, lastLineAudit] = await Promise.all([
        this.loadLastAuditTx(auditRepo, 'email'),
        this.loadLastAuditTx(auditRepo, 'line'),
      ]);
      const view = this.toView(current, lastEmailAudit, lastLineAudit);
      return {
        view,
        changedEmail: transitions.some((t) => t.channel === 'email'),
        changedLine: transitions.some((t) => t.channel === 'line'),
      };
    });

    // Write-through cache invalidation AFTER commit. Refresh BOTH slots —
    // even if only one flag flipped, the unchanged slot is still up-to-date.
    const nowTs = Date.now();
    this.cache = { value: result.view.emailEnabled, fetchedAt: nowTs };
    this.lineCache = { value: result.view.lineEnabled, fetchedAt: nowTs };

    if (result.changedEmail || result.changedLine) {
      this.logger.log(
        `[Notify kill-switch] toggled email=${result.view.emailEnabled} line=${result.view.lineEnabled} by=${actor.userId}`,
      );
    }
    return result.view;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Load the most recent audit row for a given channel (post-transaction
   * read, used by GET).
   */
  private async loadLastAudit(
    channel: AuditChannel,
  ): Promise<NotificationSettingsAudit | null> {
    return this.auditRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.changedBy', 'u')
      .where('a.setting_id = :id', { id: GLOBAL_SETTING_ID })
      .andWhere('a.channel = :channel', { channel })
      .orderBy('a.changed_at', 'DESC')
      .limit(1)
      .getOne();
  }

  /** Transaction-scoped variant. */
  private async loadLastAuditTx(
    auditRepo: Repository<NotificationSettingsAudit>,
    channel: AuditChannel,
  ): Promise<NotificationSettingsAudit | null> {
    return auditRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.changedBy', 'u')
      .where('a.setting_id = :id', { id: GLOBAL_SETTING_ID })
      .andWhere('a.channel = :channel', { channel })
      .orderBy('a.changed_at', 'DESC')
      .limit(1)
      .getOne();
  }

  private toView(
    row: NotificationSetting,
    lastEmailAudit: NotificationSettingsAudit | null,
    lastLineAudit: NotificationSettingsAudit | null,
  ): SettingsView {
    return {
      emailEnabled: row.emailEnabled,
      lineEnabled: row.lineEnabled,
      updatedAt: row.updatedAt
        ? new Date(row.updatedAt).toISOString()
        : new Date(0).toISOString(),
      lastEmailAudit: this.toAuditView(lastEmailAudit),
      lastLineAudit: this.toAuditView(lastLineAudit),
      cacheTtlSeconds: CACHE_TTL_SECONDS,
    };
  }

  private toAuditView(
    row: NotificationSettingsAudit | null,
  ): SettingsAuditView | null {
    if (!row) return null;
    const action: 'enable' | 'disable' = row.nextEnabled ? 'enable' : 'disable';
    const fullName = row.changedBy
      ? [row.changedBy.firstname, row.changedBy.lastname]
          .filter((s) => typeof s === 'string' && s.trim().length > 0)
          .join(' ')
          .trim() || null
      : null;
    return {
      actorFullName: fullName,
      actorEmailMasked: maskEmail(row.changedBy?.email ?? null),
      action,
      reason: row.reason ?? null,
      createdAt: row.changedAt,
    };
  }
}

/**
 * Mask an email for the dashboard. `john.doe@example.com` →
 * `j***e@example.com`. Returns null for null/empty input. W83 — never
 * surface the raw local-part.
 */
function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) {
    return `${local[0] ?? ''}***${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}
