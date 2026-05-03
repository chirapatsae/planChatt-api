import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationQuotaAlert } from '../entities/notification-quota-alert.entity';
import {
  CreateQuotaAlertDto,
  UpdateQuotaAlertDto,
} from './dto/quota-alert.dto';

/**
 * Wave 97 — CRUD service for `notification_quota_alerts`.
 *
 * Read/Write only — the worker (`QuotaAlertWorkerService`) owns the
 * `last_fired_at` / `last_fired_window_key` columns. CRUD endpoints
 * MUST NOT mutate them, otherwise an admin edit could un-fire a fired
 * alert and re-trigger noise.
 *
 * §17.3 — entity has NO FK into project tables.
 * §12   — no `tracking_status` writes here.
 */
@Injectable()
export class NotificationQuotaAlertsService {
  constructor(
    @InjectRepository(NotificationQuotaAlert)
    private readonly repo: Repository<NotificationQuotaAlert>,
  ) {}

  async list(): Promise<NotificationQuotaAlert[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async create(
    actorUserId: string,
    body: CreateQuotaAlertDto,
  ): Promise<NotificationQuotaAlert> {
    // W98 follow-up — `recipientEmail` is optional. When omitted, the
    // worker fans the alert out to every active admin + super-admin
    // mailbox at fire time. When provided (W97 contract), the worker
    // prefers the explicit value. We persist `null` (not an empty
    // string) so the worker can rely on `IS NULL` to drive behaviour.
    const row = this.repo.create({
      channel: body.channel,
      thresholdPercent: body.thresholdPercent,
      recipientEmail: body.recipientEmail?.trim() || null,
      enabled: body.enabled ?? true,
      createdByUserId: actorUserId,
      lastFiredAt: null,
      lastFiredWindowKey: null,
    });
    return this.repo.save(row);
  }

  async update(
    id: string,
    body: UpdateQuotaAlertDto,
  ): Promise<NotificationQuotaAlert> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('ไม่พบการตั้งค่าแจ้งเตือนโควต้า');
    }

    // CRUD does NOT touch worker-owned columns.
    if (body.channel !== undefined) row.channel = body.channel;
    if (body.thresholdPercent !== undefined) {
      row.thresholdPercent = body.thresholdPercent;
    }
    if (body.recipientEmail !== undefined) {
      // W98 follow-up — explicit empty string from the FE is normalised
      // to `null` so the worker falls back to dynamic admin lookup.
      row.recipientEmail = body.recipientEmail.trim() || null;
    }
    if (body.enabled !== undefined) row.enabled = body.enabled;

    return this.repo.save(row);
  }

  async remove(id: string): Promise<{ id: string; removed: true }> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('ไม่พบการตั้งค่าแจ้งเตือนโควต้า');
    }
    await this.repo.delete({ id });
    return { id, removed: true };
  }

  /** Used by the worker. Returns only enabled alerts. */
  async listEnabled(): Promise<NotificationQuotaAlert[]> {
    return this.repo.find({ where: { enabled: true } });
  }

  /**
   * Wave 98 PR2 — per-channel summary for the executive notifications
   * overview page. Returns the count of armed (enabled, non-deleted)
   * alerts and the most-recent `lastFiredAt` timestamp per channel.
   *
   * Single-roundtrip aggregation via `QueryBuilder` GROUP BY channel —
   * no N+1, no row-by-row scan. Channels with no rows return
   * `{ armed: 0, lastFiredAt: null }`.
   *
   * `armed` counts ENABLED alerts only — a disabled alert is configured
   * but inert; the executive surface should reflect the operationally
   * armed posture, not the configured-but-off posture. This matches the
   * UX copy "X alerts armed" in the §13 mock.
   *
   * §17.3 — read-only aggregation; no `tracking_status` write, no FK to
   * any project table.
   */
  async getSummaryByChannel(): Promise<{
    email: { armed: number; lastFiredAt: string | null };
    line: { armed: number; lastFiredAt: string | null };
  }> {
    const rows: Array<{
      channel: 'email' | 'line';
      armed: string;
      lastFiredAt: Date | null;
    }> = await this.repo
      .createQueryBuilder('a')
      .select('a.channel', 'channel')
      .addSelect('COUNT(*)', 'armed')
      .addSelect('MAX(a.last_fired_at)', 'lastFiredAt')
      .where('a.enabled = :enabled', { enabled: true })
      .groupBy('a.channel')
      .getRawMany();

    const summary = {
      email: { armed: 0, lastFiredAt: null as string | null },
      line: { armed: 0, lastFiredAt: null as string | null },
    };

    for (const row of rows) {
      if (row.channel !== 'email' && row.channel !== 'line') continue;
      summary[row.channel] = {
        armed: Number(row.armed) || 0,
        lastFiredAt: row.lastFiredAt
          ? new Date(row.lastFiredAt).toISOString()
          : null,
      };
    }

    return summary;
  }

  /**
   * Worker-owned mutation — record that an alert fired for the given
   * window key. Kept off the public CRUD surface intentionally.
   */
  async markFired(id: string, windowKey: string): Promise<void> {
    await this.repo.update(
      { id },
      { lastFiredAt: new Date(), lastFiredWindowKey: windowKey },
    );
  }

  /**
   * Worker-owned mutation — reset on window rollover so the alert can
   * fire again next window.
   */
  async resetFired(id: string, currentWindowKey: string): Promise<void> {
    await this.repo.update(
      { id },
      { lastFiredAt: null, lastFiredWindowKey: currentWindowKey },
    );
  }
}
