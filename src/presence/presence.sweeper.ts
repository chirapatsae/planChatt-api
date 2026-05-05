/**
 * W106-BE-PR1 — Stale presence sweeper.
 *
 * Runs once per minute. Most "stale" Redis keys have already expired via
 * EXPIRE 90, so this is mostly a no-op. The real value is the inverse
 * ghost-detection path inside `PresenceService.sweep()`: users whose
 * `last_seen_at` is recent but whose Redis source keys have all lapsed
 * (process crash before WS disconnect ran). For those, we emit
 * `presence:changed { online: false }` so subscribed clients flip the
 * dot to gray within ≤90s of a server crash.
 *
 * §17.3 — sweeper does NOT write to tracking_status / audit tables.
 *         It only emits an event and (transitively) reads users.last_seen_at.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PresenceService } from './presence.service';

@Injectable()
export class PresenceSweeper {
  private readonly logger = new Logger(PresenceSweeper.name);

  constructor(private readonly presence: PresenceService) {
    // One-time boot log so the registration is visible in startup output
    // (acceptance: "Cron sweeper visible in logs at boot").
    this.logger.log('Cron job registered: presence-sweep (every 60s)');
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    try {
      await this.presence.sweep();
    } catch (e: any) {
      // Swallow — presence failures must not crash the scheduler thread.
      this.logger.warn(`[presence] sweep iteration failed: ${e?.message ?? e}`);
    }
  }
}
