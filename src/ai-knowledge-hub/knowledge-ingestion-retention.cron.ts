import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';

import { AiKnowledgeIngestion } from './entities/ai-knowledge-ingestion.entity';

/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * PDPA retention cron for the connector quarantine staging table
 * (task §3.4; report §6.2; `docs/pdpa/06-retention-policy.md`).
 *
 * External payloads may contain personal data that slipped past the
 * pattern scan; rejected and never-reviewed rows must not linger
 * indefinitely. The nightly tick PURGES aged rows in place:
 * `status = 'purged'`, `payload` emptied to `{}` (the column is
 * NOT NULL by schema), `validation_errors` + `pii_flags` nulled. The
 * row SKELETON (id, source_id, idempotency_key, content_hash,
 * payload_bytes, received_at) is retained — audit trail + idempotency
 * dedupe survive erasure (PDPA right-to-erasure posture: payload
 * bodies erasable, audit persists per report §6.2).
 *
 * Targets: `rejected` rows AND unreviewed `quarantined` rows older
 * than `AI_KNOWLEDGE_STAGING_RETENTION_DAYS` (default 90). `promoted`
 * rows are NEVER purged (their content lives on in the entry and the
 * staging row is its provenance); already-`purged` rows are skipped
 * (idempotent re-run).
 *
 * CLAUDE.md references (mirrors `ai-executive-chat/retention.cron.ts`):
 *   - §17.3 — touches ONLY `ai_knowledge_ingestions`; NEVER writes
 *     `tracking_status`; no FK path into project tables.
 *   - §17.11 — no role exemption; retention applies uniformly.
 *   - §17.15.5 — "rejected/unreviewed staging rows are purged by a
 *     cron mirroring `retention.cron.ts` (env-tunable, `ai_*`-tables
 *     only, never rethrow)".
 *
 * Failure discipline: errors are logged at ERROR level but NEVER
 * rethrown — the scheduler keeps running; missed purges are caught on
 * the next tick.
 *
 * Schedule: daily 03:30 Asia/Bangkok — 30 minutes after the executive-
 * chat retention cron so the two nightly sweeps never overlap.
 */
@Injectable()
export class KnowledgeIngestionRetentionCron {
  private readonly logger = new Logger(KnowledgeIngestionRetentionCron.name);

  constructor(
    @InjectRepository(AiKnowledgeIngestion)
    private readonly ingestionRepo: Repository<AiKnowledgeIngestion>,
  ) {}

  private getRetentionDays(): number {
    const raw = process.env.AI_KNOWLEDGE_STAGING_RETENTION_DAYS;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return 90;
    return parsed;
  }

  @Cron('30 3 * * *', { timeZone: 'Asia/Bangkok' })
  async runDailyRetention(): Promise<void> {
    const startedAt = Date.now();
    const retentionDays = this.getRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    try {
      // 1. Collect aged rejected/unreviewed rows (bounded batch — the
      //    nightly delta; the remainder is caught on the next tick).
      const aged = await this.ingestionRepo.find({
        where: [
          {
            status: 'rejected',
            receivedAt: LessThan(cutoff),
            deletedAt: IsNull(),
          },
          {
            status: 'quarantined',
            receivedAt: LessThan(cutoff),
            deletedAt: IsNull(),
          },
        ],
        select: ['id'],
        take: 1000,
      });

      if (aged.length === 0) {
        this.logger.log(
          `[knowledge-retention] no aged staging rows (cutoff=${cutoff.toISOString()}, retentionDays=${retentionDays})`,
        );
        return;
      }

      // 2. Purge in place — payload body erased, skeleton retained.
      const result = await this.ingestionRepo.update(
        { id: In(aged.map((row) => row.id)) },
        {
          status: 'purged',
          payload: {},
          validationErrors: null,
          piiFlags: null,
        },
      );

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[knowledge-retention] purged rows=${result.affected ?? 0} cutoff=${cutoff.toISOString()} retentionDays=${retentionDays} durationMs=${durationMs}`,
      );
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.logger.error(
        `[knowledge-retention] failed durationMs=${durationMs}: ${err instanceof Error ? err.message : err}`,
      );
      // Swallow — next tick retries (mirror retention.cron.ts).
    }
  }
}
