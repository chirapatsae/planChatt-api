import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupLoginKillSwitchConfig } from './entities/backup-login-kill-switch-config.entity';

/**
 * SECURITY-01 §7.10 — backup-login kill-switch.
 *
 * Single-row config table; PK = literal string `BACKUP_LOGIN_ENABLED`.
 * Default `'true'` (ON) per user decision 2026-05-27. The seed runs
 * once at module boot (idempotent ON CONFLICT DO NOTHING).
 *
 * The kill-switch is checked on EVERY `/init` and `/complete` call
 * with a 30s in-memory cache to avoid a DB round-trip per attempt
 * (note: 30s lag is acceptable per SECURITY-01 — disabling the switch
 * during an incident does not need to be instant).
 */
@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger(KillSwitchService.name);
  private readonly KEY = 'BACKUP_LOGIN_ENABLED';
  private readonly CACHE_TTL_MS = 30_000;

  private cached: { enabled: boolean; readAt: number } | null = null;

  constructor(
    @InjectRepository(BackupLoginKillSwitchConfig)
    private readonly cfgRepo: Repository<BackupLoginKillSwitchConfig>,
  ) {}

  /**
   * Idempotent boot seed — default ON per SECURITY-01 §7.10.
   *
   * Uses INSERT ... ON CONFLICT DO NOTHING. Safe to re-run on every
   * boot. Returns true if a fresh row was inserted.
   */
  async seedDefault(): Promise<boolean> {
    const existing = await this.cfgRepo.findOne({ where: { key: this.KEY } });
    if (existing) return false;
    try {
      await this.cfgRepo.insert({
        key: this.KEY,
        value: 'true',
        description:
          'Backup-login kill-switch (default ON per user decision 2026-05-27)',
      });
      this.logger.log(
        '[KillSwitch] seeded BACKUP_LOGIN_ENABLED=true (default ON)',
      );
      return true;
    } catch (err) {
      // Race with another booting instance — fine.
      this.logger.warn(
        `[KillSwitch] seed insert race: ${(err as Error).message}`,
      );
      return false;
    }
  }

  async isEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.cached && now - this.cached.readAt < this.CACHE_TTL_MS) {
      return this.cached.enabled;
    }
    try {
      const row = await this.cfgRepo.findOne({ where: { key: this.KEY } });
      const enabled = (row?.value ?? 'true') === 'true';
      this.cached = { enabled, readAt: now };
      return enabled;
    } catch (err) {
      this.logger.warn(
        `[KillSwitch] read failed (fail-CLOSED): ${(err as Error).message}`,
      );
      // Fail-closed: if the DB is unreachable, prefer refusing backup
      // login over silently allowing it. This is the safer default
      // given the design framing (backup login is the emergency
      // fallback; primary auth is ThaiD).
      return false;
    }
  }

  async setEnabled(
    enabled: boolean,
    actorUserId: string | null,
  ): Promise<void> {
    await this.cfgRepo.upsert(
      {
        key: this.KEY,
        value: enabled ? 'true' : 'false',
        updatedByUserId: actorUserId,
        description: enabled
          ? 'Backup-login enabled (default ON state)'
          : 'Backup-login disabled (incident mode)',
      },
      ['key'],
    );
    this.cached = { enabled, readAt: Date.now() };
  }
}
