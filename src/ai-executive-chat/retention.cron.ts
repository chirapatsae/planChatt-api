import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { AiExecutiveConversation } from './entities/ai-executive-conversation.entity';
import { AiExecutiveMessage } from './entities/ai-executive-message.entity';

/**
 * PRIV-W44-01 — PDPA retention cron for executive chat history.
 *
 * Purpose:
 *   Thailand PDPA (พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562) requires a
 *   defined retention window for personal data. Executive chat logs
 *   fall squarely in scope: they contain free-text questions from
 *   named officers plus LLM responses that may reference project
 *   specifics. A daily cron enforces the configured TTL by
 *   soft-deleting records whose `updated_at` predates the cutoff.
 *
 * CLAUDE.md references:
 *   - §17.3 audit separation — this cron touches ONLY `ai_*` tables
 *     (`ai_executive_conversations` + `ai_executive_messages`). It
 *     NEVER writes to `tracking_status` and has no FK path into
 *     project / plan tables.
 *   - §17.11 no role exemption — retention applies uniformly. A
 *     super-admin's conversations are subject to the same TTL as an
 *     ordinary executive's.
 *
 * Configuration:
 *   - `AI_CONVERSATION_RETENTION_DAYS` (default 90) — cutoff horizon.
 *   - Cron schedule: daily at 03:00 Asia/Bangkok (off-peak for the
 *     Thai user base).
 *
 * Failure discipline: errors are logged at ERROR level but NEVER
 * rethrown — the scheduler must keep running even if one nightly run
 * hits a transient DB hiccup. Missed deletions are caught on the
 * next tick.
 */
@Injectable()
export class AiExecutiveChatRetentionCron {
  private readonly logger = new Logger(AiExecutiveChatRetentionCron.name);

  constructor(
    @InjectRepository(AiExecutiveConversation)
    private readonly conversationRepo: Repository<AiExecutiveConversation>,
    @InjectRepository(AiExecutiveMessage)
    private readonly messageRepo: Repository<AiExecutiveMessage>,
  ) {}

  private getRetentionDays(): number {
    const raw = process.env.AI_CONVERSATION_RETENTION_DAYS;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return 90;
    return parsed;
  }

  /**
   * Daily tick at 03:00 Asia/Bangkok. Soft-deletes aged
   * conversations and their messages in separate statements because
   * `@DeleteDateColumn` does not cascade a soft delete through the
   * `onDelete: 'CASCADE'` relation (that fires only on hard DELETE).
   */
  @Cron('0 3 * * *', { timeZone: 'Asia/Bangkok' })
  async runDailyRetention(): Promise<void> {
    const startedAt = Date.now();
    const retentionDays = this.getRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    try {
      // 1. Find active conversation IDs past the cutoff (small result
      //    set; soft-delete batch is bounded by the daily delta).
      const aged = await this.conversationRepo.find({
        where: {
          deletedAt: IsNull(),
          updatedAt: LessThan(cutoff),
        },
        select: ['id'],
        take: 1000, // §11 risk doc — batch safeguard.
      });

      if (aged.length === 0) {
        this.logger.log(
          `[retention] no aged conversations (cutoff=${cutoff.toISOString()}, retentionDays=${retentionDays})`,
        );
        return;
      }

      const ids = aged.map((c) => c.id);

      // 2. Soft-delete messages first (so the message count is
      //    accurate regardless of any parent race).
      const msgResult = await this.messageRepo.softDelete({
        conversationId: In(ids),
      });

      // 3. Soft-delete the conversations themselves.
      const convResult = await this.conversationRepo.softDelete(ids);

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[retention] softDeleted conversations=${convResult.affected ?? 0} messages=${msgResult.affected ?? 0} cutoff=${cutoff.toISOString()} retentionDays=${retentionDays} durationMs=${durationMs}`,
      );
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.logger.error(
        `[retention] failed durationMs=${durationMs}: ${err instanceof Error ? err.message : err}`,
      );
      // Swallow — next tick retries.
    }
  }
}
