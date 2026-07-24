import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { normalize, sep } from 'path';
import { LessThan, Not, Repository } from 'typeorm';

import { CitizenLoginOtp } from './entities/citizen-login-otp.entity';
import { CitizenRegistrationOtp } from './entities/citizen-registration-otp.entity';
import { CitizenSession } from './entities/citizen-session.entity';
import { CitizenPostMedia } from './entities/citizen-post-media.entity';
import { CitizenStory } from './entities/citizen-story.entity';
import { CitizenStoryReaction } from './entities/citizen-story-reaction.entity';
import { CitizenStoryView } from './entities/citizen-story-view.entity';
import { CitizenStorageService } from './media/citizen-storage.service';

/**
 * CitizenRetentionCron — PDPA on-disk blob sweeper for citizen-engagement
 * uploads (W-GATE-3 stories + C2 post media).
 *
 * Why this exists:
 *   `citizen_story` rows expire at 24h (`expires_at`) or are soft-deleted by
 *   the owner (`CitizenStoryService.removeOwn`) / by erasure
 *   (`CitizenDsarService.eraseMine`); `citizen_post_media` rows are soft-deleted
 *   on post removal / erasure. In NONE of these paths are the on-disk image
 *   bytes removed — the privacy-stripped photo of a citizen would otherwise
 *   linger on disk indefinitely. That is a PDPA storage-limitation /
 *   right-to-erasure residue (§37, §39). This daily sweeper deletes the orphaned
 *   blob and clears the pointer column so the bytes are gone.
 *
 * Disposal method (mirrors `docs/pdpa/06-retention-policy.md`):
 *   - §B / §C "Profile image → Delete file + clear column" is the precedent:
 *     remove the FILE, NULL/clear the path column, KEEP the row tombstone. The
 *     citizen audit trail lives separately in `citizen_audit_logs` (story.create
 *     / story.delete / account.erase), so the row tombstone is not the audit
 *     source and clearing the path destroys no audit history.
 *   - §K knowledge-staging "purge in place, keep skeleton for idempotency": the
 *     cleared path column (`''`) doubles as the idempotency marker so an
 *     already-swept row is never re-scanned.
 *
 * §17.3 isolation: this cron touches ONLY `citizen_*` tables
 * (`citizen_story`, `citizen_post_media`) and the swappable
 * `CitizenStorageService` blob seam. It NEVER writes `tracking_status`, has no
 * FK path into any project / users / work_history table, and only ever unlinks
 * files under the citizen upload directories (defense-in-depth path guard).
 *
 * Configuration (env-tunable):
 *   - `CITIZEN_RETENTION_ENABLED`     — `0|false|no|off` disables the sweep (default on).
 *   - `CITIZEN_RETENTION_GRACE_HOURS` — grace window after expiry/soft-delete
 *                                       before the blob is purged (default 1, must be > 0).
 *   - `CITIZEN_RETENTION_BATCH_SIZE`  — max rows per kind per tick (default 1000).
 *   - Cron schedule: daily 03:15 Asia/Bangkok — staggered between the exec-chat
 *     retention cron (03:00) and the knowledge-staging cron (03:30) so the
 *     nightly sweeps never overlap.
 *
 * Failure discipline (mirrors `retention.cron.ts`): per-row failures are logged
 * and skipped (the row's column stays set so the next tick retries); the whole
 * run is wrapped so an error is logged at ERROR level but NEVER rethrown — the
 * scheduler must keep running and missed blobs are caught on the next tick.
 */
@Injectable()
export class CitizenRetentionCron {
  private readonly logger = new Logger(CitizenRetentionCron.name);

  /** Default grace window (hours) between expiry/soft-delete and blob purge. */
  private static readonly DEFAULT_GRACE_HOURS = 1;

  /** Default per-kind row cap per tick (§K batch-safeguard convention). */
  private static readonly DEFAULT_BATCH_SIZE = 1000;

  /**
   * Session rows get a longer, FIXED 7-day grace past expiry/revoke (so a
   * recently-used device lingers briefly in the device-manager listing before
   * being purged), independent of the short blob-grace used for the OTP/media
   * sweeps above.
   */
  private static readonly SESSION_GRACE_DAYS = 7;

  /**
   * The ONLY directories this cron may ever unlink under. A storage key that
   * does not sit beneath one of these is treated as corrupt and skipped — the
   * sweeper never deletes a file outside the citizen upload roots.
   */
  private static readonly ALLOWED_BASES = [
    'uploads/citizen-stories',
    'uploads/citizen-media',
  ];

  constructor(
    @InjectRepository(CitizenStory)
    private readonly storyRepo: Repository<CitizenStory>,
    @InjectRepository(CitizenPostMedia)
    private readonly mediaRepo: Repository<CitizenPostMedia>,
    @InjectRepository(CitizenStoryView)
    private readonly storyViewRepo: Repository<CitizenStoryView>,
    @InjectRepository(CitizenStoryReaction)
    private readonly storyReactionRepo: Repository<CitizenStoryReaction>,
    @InjectRepository(CitizenLoginOtp)
    private readonly loginOtpRepo: Repository<CitizenLoginOtp>,
    @InjectRepository(CitizenRegistrationOtp)
    private readonly registrationOtpRepo: Repository<CitizenRegistrationOtp>,
    @InjectRepository(CitizenSession)
    private readonly sessionRepo: Repository<CitizenSession>,
    private readonly storage: CitizenStorageService,
  ) {}

  // ---------------------------------------------------------------------------
  // schedule entry point
  // ---------------------------------------------------------------------------

  @Cron('15 3 * * *', { timeZone: 'Asia/Bangkok' })
  async runDailyRetention(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('[citizen-retention] disabled via env; skipping');
      return;
    }

    const startedAt = Date.now();
    const graceHours = this.getGraceHours();
    const batchSize = this.getBatchSize();
    const cutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000);

    try {
      const stories = await this.sweepStories(cutoff, batchSize);
      const media = await this.sweepMedia(cutoff, batchSize);
      const engagement = await this.sweepStoryEngagement(cutoff, batchSize);
      const loginOtp = await this.sweepLoginOtp(cutoff, batchSize);
      const registrationOtp = await this.sweepRegistrationOtp(cutoff, batchSize);
      // Sessions use their OWN 7-day grace cutoff (not the short blob cutoff).
      const sessionCutoff = new Date(
        Date.now() -
          CitizenRetentionCron.SESSION_GRACE_DAYS * 24 * 60 * 60 * 1000,
      );
      const sessions = await this.sweepCitizenSessions(sessionCutoff, batchSize);

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[citizen-retention] swept stories{${this.fmt(stories)}} ` +
          `media{${this.fmt(media)}} ` +
          `storyEngagement{${this.fmtEngagement(engagement)}} ` +
          `loginOtp{${this.fmtOtp(loginOtp)}} ` +
          `registrationOtp{${this.fmtOtp(registrationOtp)}} ` +
          `sessions{${this.fmtOtp(sessions)}} ` +
          `cutoff=${cutoff.toISOString()} graceHours=${graceHours} ` +
          `sessionCutoff=${sessionCutoff.toISOString()} ` +
          `batchSize=${batchSize} durationMs=${durationMs}`,
      );
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.logger.error(
        `[citizen-retention] failed durationMs=${durationMs}: ${this.msg(err)}`,
      );
      // Swallow — the scheduler keeps running; the next tick retries.
    }
  }

  // ---------------------------------------------------------------------------
  // per-kind sweeps
  // ---------------------------------------------------------------------------

  /**
   * Story blobs are purgeable once the story is either expired beyond the grace
   * window OR soft-deleted beyond the grace window, AND its `image_path` has not
   * already been cleared by a prior tick. `withDeleted` is required so the
   * soft-deleted rows are visible to the sweep.
   */
  private async sweepStories(
    cutoff: Date,
    batchSize: number,
  ): Promise<SweepStats> {
    const rows = await this.storyRepo.find({
      withDeleted: true,
      where: [
        // expired ≥ grace ago (regardless of soft-delete state)
        { imagePath: Not(''), expiresAt: LessThan(cutoff) },
        // soft-deleted ≥ grace ago (NULL deleted_at never matches LessThan)
        { imagePath: Not(''), deletedAt: LessThan(cutoff) },
      ],
      order: { createdAt: 'ASC' },
      take: batchSize,
    });

    return this.purgeRows(
      rows.map((r) => ({ id: r.id, key: r.imagePath })),
      (id) => this.storyRepo.update({ id }, { imagePath: '' }),
    );
  }

  /**
   * Media blobs are purgeable once the media row is soft-deleted beyond the
   * grace window (post removal or DSAR erasure) and its `storage_key` has not
   * already been cleared. Media has no `expires_at` — only soft-deleted rows are
   * swept; live attached media is never touched.
   */
  private async sweepMedia(
    cutoff: Date,
    batchSize: number,
  ): Promise<SweepStats> {
    const rows = await this.mediaRepo.find({
      withDeleted: true,
      where: { storageKey: Not(''), deletedAt: LessThan(cutoff) },
      order: { createdAt: 'ASC' },
      take: batchSize,
    });

    return this.purgeRows(
      rows.map((r) => ({ id: r.id, key: r.storageKey })),
      (id) => this.mediaRepo.update({ id }, { storageKey: '' }),
    );
  }

  /**
   * FB-6 story-engagement sweep: HARD-DELETE `citizen_story_views` +
   * `citizen_story_reactions` rows whose parent story is expired OR soft-deleted
   * beyond the grace window. These tables carry NO on-disk blob (unlike stories /
   * media), so there is nothing to unlink — a straight row purge is sufficient.
   *
   * Same tick, same grace `cutoff`, same `batchSize` env var, and the SAME
   * per-row failure discipline as `sweepStories`: candidates are the
   * still-populated expired stories (so the sweep progresses and never re-scans
   * an already-emptied story), and one bad story never aborts the batch — the
   * next tick retries whatever remains.
   */
  private async sweepStoryEngagement(
    cutoff: Date,
    batchSize: number,
  ): Promise<EngagementSweepStats> {
    // Candidate story ids: expired/soft-deleted past the cutoff that STILL carry
    // engagement rows (join the engagement tables → only populated stories
    // surface, so the sweep advances instead of re-scanning emptied stories).
    const [viewStories, reactionStories] = await Promise.all([
      this.storyViewRepo
        .createQueryBuilder('v')
        .innerJoin(CitizenStory, 's', 's.id = v.story_id')
        .where('(s.expires_at < :cutoff OR s.deleted_at < :cutoff)', { cutoff })
        .select('DISTINCT v.story_id', 'storyId')
        .limit(batchSize)
        .getRawMany<{ storyId: string }>(),
      this.storyReactionRepo
        .createQueryBuilder('r')
        .innerJoin(CitizenStory, 's', 's.id = r.story_id')
        .where('(s.expires_at < :cutoff OR s.deleted_at < :cutoff)', { cutoff })
        .select('DISTINCT r.story_id', 'storyId')
        .limit(batchSize)
        .getRawMany<{ storyId: string }>(),
    ]);

    const storyIds = [
      ...new Set(
        [...viewStories, ...reactionStories].map((x) => x.storyId),
      ),
    ];

    const stats: EngagementSweepStats = {
      scanned: storyIds.length,
      viewsDeleted: 0,
      reactionsDeleted: 0,
      storiesProcessed: 0,
      errors: 0,
    };

    for (const storyId of storyIds) {
      try {
        const views = await this.storyViewRepo.delete({ storyId });
        const reactions = await this.storyReactionRepo.delete({ storyId });
        stats.viewsDeleted += views.affected ?? 0;
        stats.reactionsDeleted += reactions.affected ?? 0;
        stats.storiesProcessed++;
      } catch (err) {
        stats.errors++;
        this.logger.warn(
          `[citizen-retention] story ${storyId} engagement purge failed: ${this.msg(err)}`,
        );
      }
    }

    return stats;
  }

  /**
   * Login-OTP sweep: HARD-DELETE `citizen_login_otp` rows that are expired OR
   * consumed beyond the grace window. These are short-lived 2FA challenges with
   * NO on-disk blob (like the story-engagement tables), so a straight row purge
   * is sufficient. `consumed_at < cutoff` never matches a NULL (unconsumed) row,
   * so a live-but-unexpired challenge is never touched.
   *
   * Same tick, same grace `cutoff`, same `batchSize` env var, and the SAME
   * per-row failure discipline as the other sweeps: one bad row never aborts the
   * batch — the next tick retries whatever remains.
   */
  private async sweepLoginOtp(
    cutoff: Date,
    batchSize: number,
  ): Promise<OtpSweepStats> {
    const rows = await this.loginOtpRepo.find({
      where: [{ expiresAt: LessThan(cutoff) }, { consumedAt: LessThan(cutoff) }],
      order: { createdAt: 'ASC' },
      take: batchSize,
      select: { id: true },
    });

    const stats: OtpSweepStats = { scanned: rows.length, deleted: 0, errors: 0 };
    for (const row of rows) {
      try {
        const res = await this.loginOtpRepo.delete({ id: row.id });
        stats.deleted += res.affected ?? 0;
      } catch (err) {
        stats.errors++;
        this.logger.warn(
          `[citizen-retention] login-otp ${row.id} purge failed: ${this.msg(err)}`,
        );
      }
    }
    return stats;
  }

  /**
   * Registration-OTP sweep: HARD-DELETE `citizen_registration_otp` rows that are
   * expired OR consumed beyond the grace window. Clone of `sweepLoginOtp` — these
   * are short-lived verify-email-first challenges with NO on-disk blob and NO
   * identity FK, so a straight row purge is sufficient. `consumed_at < cutoff`
   * never matches a NULL (unconsumed) row, so a live-but-unexpired challenge is
   * never touched. Same tick / grace `cutoff` / `batchSize` / per-row failure
   * discipline as the other sweeps.
   */
  private async sweepRegistrationOtp(
    cutoff: Date,
    batchSize: number,
  ): Promise<OtpSweepStats> {
    const rows = await this.registrationOtpRepo.find({
      where: [{ expiresAt: LessThan(cutoff) }, { consumedAt: LessThan(cutoff) }],
      order: { createdAt: 'ASC' },
      take: batchSize,
      select: { id: true },
    });

    const stats: OtpSweepStats = { scanned: rows.length, deleted: 0, errors: 0 };
    for (const row of rows) {
      try {
        const res = await this.registrationOtpRepo.delete({ id: row.id });
        stats.deleted += res.affected ?? 0;
      } catch (err) {
        stats.errors++;
        this.logger.warn(
          `[citizen-retention] registration-otp ${row.id} purge failed: ${this.msg(err)}`,
        );
      }
    }
    return stats;
  }

  /**
   * Session sweep: HARD-DELETE `citizen_session` rows whose `expires_at` OR
   * `revoked_at` is older than the 7-day session grace `cutoff`. Clone of
   * `sweepLoginOtp` discipline — no on-disk blob, straight row purge, one bad
   * row never aborts the batch. `revoked_at < cutoff` never matches a NULL
   * (still-active) row, so a live session is never touched.
   */
  private async sweepCitizenSessions(
    cutoff: Date,
    batchSize: number,
  ): Promise<OtpSweepStats> {
    const rows = await this.sessionRepo.find({
      where: [{ expiresAt: LessThan(cutoff) }, { revokedAt: LessThan(cutoff) }],
      order: { createdAt: 'ASC' },
      take: batchSize,
      select: { id: true },
    });

    const stats: OtpSweepStats = { scanned: rows.length, deleted: 0, errors: 0 };
    for (const row of rows) {
      try {
        const res = await this.sessionRepo.delete({ id: row.id });
        stats.deleted += res.affected ?? 0;
      } catch (err) {
        stats.errors++;
        this.logger.warn(
          `[citizen-retention] session ${row.id} purge failed: ${this.msg(err)}`,
        );
      }
    }
    return stats;
  }

  // ---------------------------------------------------------------------------
  // shared purge engine
  // ---------------------------------------------------------------------------

  /**
   * For each candidate: delete its on-disk blob (or accept an already-absent
   * file as success), then clear the pointer column so the row is never
   * re-scanned. A transient delete failure leaves the column set so the next
   * tick retries. One bad row never aborts the batch.
   */
  private async purgeRows(
    rows: Array<{ id: string; key: string }>,
    clearColumn: (id: string) => Promise<unknown>,
  ): Promise<SweepStats> {
    const stats: SweepStats = {
      scanned: rows.length,
      filesDeleted: 0,
      alreadyAbsent: 0,
      rowsCleared: 0,
      skippedUnsafe: 0,
      errors: 0,
    };

    for (const row of rows) {
      try {
        const outcome = await this.purgeFile(row.key);
        if (outcome === 'unsafe') {
          stats.skippedUnsafe++;
          continue; // leave the pointer set; corrupt key needs human review
        }
        if (outcome === 'deleted') stats.filesDeleted++;
        else stats.alreadyAbsent++;

        // File is gone (deleted now or already absent) → safe to clear the
        // pointer column so the blob is unreferenced and the row is not
        // re-scanned next tick.
        await clearColumn(row.id);
        stats.rowsCleared++;
      } catch (err) {
        stats.errors++;
        this.logger.warn(
          `[citizen-retention] row ${row.id} purge failed: ${this.msg(err)}`,
        );
      }
    }

    return stats;
  }

  /**
   * Delete a single blob through the swappable storage seam.
   * - `unsafe`  — key is corrupt / out of the citizen upload roots; do not touch disk.
   * - `deleted` — the file was unlinked this run.
   * - `absent`  — the file was already gone (ENOENT) → idempotent success.
   * Any other error is rethrown to the per-row handler so the column is NOT
   * cleared and the next tick retries.
   */
  private async purgeFile(key: string): Promise<'deleted' | 'absent' | 'unsafe'> {
    if (!this.isSafeKey(key)) {
      this.logger.warn(
        `[citizen-retention] refusing out-of-scope storage key: ${key}`,
      );
      return 'unsafe';
    }
    try {
      await this.storage.remove(key);
      return 'deleted';
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent';
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // guards & config
  // ---------------------------------------------------------------------------

  /**
   * A key is sweepable only when it normalizes to a path beneath one of the
   * citizen upload roots and contains no `..` traversal. Forward-slash
   * normalization keeps the prefix check platform-independent and aligned with
   * how `CitizenStorageService` builds keys.
   */
  private isSafeKey(key: string): boolean {
    if (!key || typeof key !== 'string') return false;
    const norm = normalize(key).split(sep).join('/');
    if (norm.includes('..')) return false;
    return CitizenRetentionCron.ALLOWED_BASES.some((base) =>
      norm.startsWith(`${base}/`),
    );
  }

  private isEnabled(): boolean {
    const raw = process.env.CITIZEN_RETENTION_ENABLED;
    if (raw === undefined) return true;
    return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
  }

  private getGraceHours(): number {
    const raw = process.env.CITIZEN_RETENTION_GRACE_HOURS;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return CitizenRetentionCron.DEFAULT_GRACE_HOURS;
    }
    return parsed;
  }

  private getBatchSize(): number {
    const raw = process.env.CITIZEN_RETENTION_BATCH_SIZE;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return CitizenRetentionCron.DEFAULT_BATCH_SIZE;
    }
    return parsed;
  }

  private fmt(s: SweepStats): string {
    return (
      `scanned=${s.scanned} filesDeleted=${s.filesDeleted} ` +
      `alreadyAbsent=${s.alreadyAbsent} rowsCleared=${s.rowsCleared} ` +
      `skippedUnsafe=${s.skippedUnsafe} errors=${s.errors}`
    );
  }

  private fmtEngagement(s: EngagementSweepStats): string {
    return (
      `scanned=${s.scanned} viewsDeleted=${s.viewsDeleted} ` +
      `reactionsDeleted=${s.reactionsDeleted} ` +
      `storiesProcessed=${s.storiesProcessed} errors=${s.errors}`
    );
  }

  private fmtOtp(s: OtpSweepStats): string {
    return `scanned=${s.scanned} deleted=${s.deleted} errors=${s.errors}`;
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Per-kind sweep counters, surfaced in the summary log line. */
interface SweepStats {
  scanned: number;
  filesDeleted: number;
  alreadyAbsent: number;
  rowsCleared: number;
  skippedUnsafe: number;
  errors: number;
}

/** FB-6 story-engagement sweep counters (no on-disk blob → row purge only). */
interface EngagementSweepStats {
  scanned: number;
  viewsDeleted: number;
  reactionsDeleted: number;
  storiesProcessed: number;
  errors: number;
}

/** Login-OTP sweep counters (no on-disk blob → row purge only). */
interface OtpSweepStats {
  scanned: number;
  deleted: number;
  errors: number;
}
