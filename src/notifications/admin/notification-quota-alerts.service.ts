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
    const row = this.repo.create({
      channel: body.channel,
      thresholdPercent: body.thresholdPercent,
      recipientEmail: body.recipientEmail,
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
      row.recipientEmail = body.recipientEmail;
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
