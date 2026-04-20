import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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

/** In-process cache TTL for `isEmailEnabled()`. See §cache semantics below. */
const CACHE_TTL_MS = 5_000;

/**
 * Shape returned by the read + write endpoints. Flattened so the controller
 * can hand it straight to the FE dashboard without a transformer layer.
 */
export interface EmailSettingsView {
  emailEnabled: boolean;
  lastChangedAt: Date;
  lastChangedBy?: { id: string; email: string } | null;
}

/**
 * Wave 22 B2 — global email kill-switch service.
 *
 * Source of truth:
 *   - docs/tasks/IMPLEMENT_EMAIL_KILL_SWITCH.md §7
 *   - Entities: NotificationSetting + NotificationSettingsAudit (D1)
 *   - CLAUDE.md §4.1 (kill-switch OFF MUST NOT fail any workflow transition)
 *   - CLAUDE.md §12   (audit writes land in `notification_settings_audit`,
 *                      NEVER in `tracking_status`)
 *   - CLAUDE.md §17.11 (no role exemption — kill-switch is integrity-neutral)
 *
 * Guarantees:
 *   - `isEmailEnabled()` is fail-closed: any DB error resolves to `false`
 *     so an outage cannot produce accidental unsolicited mail.
 *   - In-process 5-second TTL cache with write-through invalidation on
 *     `updateSettings()`. Per-process only (multi-instance deployments may
 *     see up to 5 s of divergence — documented in the task risks section).
 *   - Every state change writes exactly one row to
 *     `notification_settings_audit`. No-op toggles (same value re-sent)
 *     are idempotent and do NOT write audit rows.
 */
@Injectable()
export class NotificationSettingsService {
  private readonly logger = new Logger(NotificationSettingsService.name);

  /** Cached `emailEnabled` value with fetch timestamp. */
  private cache: { value: boolean; fetchedAt: number } | null = null;

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
   * pending, etc.) we log a warning and return `false`. Missed emails are
   * recoverable; accidental sends during an outage are not.
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
      // Missing row is treated as OFF. D1 migration seeds it on deploy; if
      // it is somehow absent (hand-deleted, migration skipped) we would
      // rather short-circuit than send.
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
   * Load the full settings row for the GET /admin/email-settings endpoint.
   * Includes the relation to the user who last flipped the switch so the
   * dashboard can show "last changed by <display email> at <timestamp>".
   *
   * Throws `NotFoundException` if the seed row is missing — this is an
   * infrastructure-level bug worth surfacing rather than hiding.
   */
  async getSettings(): Promise<EmailSettingsView> {
    const row = await this.settingsRepo.findOne({
      where: { id: GLOBAL_SETTING_ID },
      relations: ['lastChangedBy'],
    });
    if (!row) {
      throw new NotFoundException(
        'ไม่พบข้อมูลการตั้งค่าการแจ้งเตือนอีเมล (seed row missing)',
      );
    }
    return this.toView(row);
  }

  /**
   * Apply a PATCH /admin/email-settings request.
   *
   * Contract:
   *   - Idempotent: if the incoming `emailEnabled` already matches the
   *     current row, no audit row is written and the cache is still
   *     refreshed. This matches the task's acceptance criterion:
   *     "Toggle back to false idempotency: second identical PATCH does
   *     NOT re-audit".
   *   - Transactional: the settings UPDATE and audit INSERT happen in a
   *     single transaction so the trail never desyncs from the state.
   *   - Write-through invalidation: we clear the in-process cache AFTER
   *     the transaction commits. The next `isEmailEnabled()` call observes
   *     the new value immediately (< 5 s TTL is the worst case for other
   *     instances, not this one).
   *
   * Actor:
   *   - `actor.userId` is captured from `req.user.userId` at the controller
   *     layer. Never trust a client-supplied actor.
   *   - `actor.workHistoryId` is currently unused on the audit row but
   *     accepted in the signature for symmetry with Wave 22 B1's actor
   *     threading on `notification_email_logs`. Future audit surfaces may
   *     consume it.
   */
  async updateSettings(
    actor: { userId: string; workHistoryId?: string | null },
    body: { emailEnabled: boolean; reason?: string },
  ): Promise<EmailSettingsView> {
    const manager = this.settingsRepo.manager;
    const view = await manager.transaction(async (tx) => {
      const settingsRepo = tx.getRepository(NotificationSetting);
      const auditRepo = tx.getRepository(NotificationSettingsAudit);

      // Row-lock so two concurrent super-admins do not race each other into
      // an inconsistent audit trail.
      const current = await settingsRepo
        .createQueryBuilder('s')
        .setLock('pessimistic_write')
        .where('s.id = :id', { id: GLOBAL_SETTING_ID })
        .getOne();

      if (!current) {
        throw new NotFoundException(
          'ไม่พบข้อมูลการตั้งค่าการแจ้งเตือนอีเมล (seed row missing)',
        );
      }

      // Idempotent short-circuit — value already matches. Still return
      // the current view (with lastChangedBy hydrated) so the caller gets
      // a consistent response envelope.
      if (current.emailEnabled === body.emailEnabled) {
        const hydrated = await settingsRepo.findOne({
          where: { id: GLOBAL_SETTING_ID },
          relations: ['lastChangedBy'],
        });
        return this.toView(hydrated ?? current);
      }

      const prevEnabled = current.emailEnabled;
      current.emailEnabled = body.emailEnabled;
      current.lastChangedAt = new Date();
      current.lastChangedById = actor.userId;
      current.updatedAt = new Date();
      await settingsRepo.save(current);

      await auditRepo.insert({
        settingId: GLOBAL_SETTING_ID,
        prevEnabled,
        nextEnabled: body.emailEnabled,
        changedById: actor.userId,
        changedAt: new Date(),
        reason: body.reason ?? null,
      });

      // Re-read with relation so we can return a shaped response to the FE.
      const hydrated = await settingsRepo.findOne({
        where: { id: GLOBAL_SETTING_ID },
        relations: ['lastChangedBy'],
      });
      return this.toView(hydrated ?? current);
    });

    // Write-through cache invalidation. Doing this AFTER commit ensures
    // readers never observe an unflushed value.
    this.cache = { value: view.emailEnabled, fetchedAt: Date.now() };
    this.logger.log(
      `[Notify kill-switch] toggled emailEnabled=${view.emailEnabled} by=${actor.userId}`,
    );
    return view;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private toView(row: NotificationSetting): EmailSettingsView {
    const by = row.lastChangedBy
      ? {
          id: row.lastChangedBy.id,
          email: row.lastChangedBy.email ?? '',
        }
      : null;
    return {
      emailEnabled: row.emailEnabled,
      lastChangedAt: row.lastChangedAt,
      lastChangedBy: by,
    };
  }
}
