import {
  Controller,
  Post,
  UseGuards,
  Req,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository } from 'typeorm';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { AttachmentProjectGroup } from 'src/attachment-project-groups/entities/attachment-project-group.entity';
import { AttachmentRevisedProjectGroup } from 'src/attachment-revised-project-groups/entities/attachment-revised-project-group.entity';
import { DocumentAnalysisService } from 'src/document-analysis/document-analysis.service';

/**
 * Admin backfill endpoint (Phase 3 §3.3 + Phase 4 §T4 smart-skip).
 *
 * Re-enqueues analysis for attachment rows that are either:
 *   (a) stuck at `ai_status = 'pending'` (original Phase 3 use case), or
 *   (b) `ai_status = 'done'` but the derived output is of low quality —
 *       specifically either `ai_extraction_quality_score < BACKFILL_MIN_QUALITY`
 *       (default 0.5) or `ai_summary` is empty (a post-hoc cleanup bucket).
 *
 * Rows that are `ai_status = 'done'` AND have a quality score at or above
 * the threshold AND a non-empty summary are SKIPPED (not queued). This
 * makes the endpoint idempotent — repeated invocations don't waste
 * OpenAI tokens re-summarising already-good rows.
 *
 * Role: staff-lead only (`staff | admin | super-admin`).
 * Cooldown: 60 s per user (anti-spam).
 * Concurrency: per-row `processAttachment` is fire-and-forget; the Phase 1
 * OpenAI semaphore caps concurrency at 3 regardless of queue depth.
 *
 * Response shape (BACKWARD-COMPATIBLE):
 *   { queued, skipped, byKind: { projectGroup, revisedProjectGroup }, throttled?, retryAfterMs? }
 *
 *   - `queued`  existed in Phase 3 — unchanged.
 *   - `byKind`  existed in Phase 3 — unchanged.
 *   - `skipped` NEW in Phase 4; clients that don't read it are unaffected.
 */

const STAFF_LEAD_ROLES = new Set(['staff', 'admin', 'super-admin']);
const COOLDOWN_MS = 60_000;

function resolveMinQuality(): number {
  const raw = process.env.BACKFILL_MIN_QUALITY;
  if (!raw) return 0.5;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0.5;
  return parsed;
}

@Controller({
  path: 'admin/document-analysis',
  version: '1',
})
export class AdminDocumentAnalysisController {
  private readonly logger = new Logger(AdminDocumentAnalysisController.name);
  private readonly lastCall = new Map<string, number>();

  constructor(
    @InjectRepository(AttachmentProjectGroup)
    private readonly apgRepo: Repository<AttachmentProjectGroup>,
    @InjectRepository(AttachmentRevisedProjectGroup)
    private readonly arpgRepo: Repository<AttachmentRevisedProjectGroup>,
    private readonly documentAnalysisService: DocumentAnalysisService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('backfill')
  @HttpCode(HttpStatus.ACCEPTED)
  async backfill(@Req() req: Request & { user: JwtPayloadUser }) {
    const user = req.user;
    if (!STAFF_LEAD_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'เฉพาะเจ้าหน้าที่ (staff / admin / super-admin) เท่านั้นที่สามารถสั่ง backfill ได้',
      );
    }

    const last = this.lastCall.get(user.userId) ?? 0;
    const now = Date.now();
    if (now - last < COOLDOWN_MS) {
      return {
        queued: 0,
        skipped: 0,
        byKind: { projectGroup: 0, revisedProjectGroup: 0 },
        throttled: true,
        retryAfterMs: COOLDOWN_MS - (now - last),
      };
    }
    this.lastCall.set(user.userId, now);

    const minQuality = resolveMinQuality();

    // Phase 4 §T4 — we now fetch two buckets per table:
    //   1. `pending` rows (original Phase 3 behaviour)
    //   2. `done` rows whose extraction is LOW quality (score < minQuality
    //      OR null, OR empty summary). These are the "re-processed" bucket.
    // Everything else is counted as skipped — see aggregate query below.
    const [queueApg, totalDoneApg, queueArpg, totalDoneArpg] =
      await Promise.all([
        this.selectQueueable(this.apgRepo, minQuality),
        this.countDone(this.apgRepo),
        this.selectQueueable(this.arpgRepo, minQuality),
        this.countDone(this.arpgRepo),
      ]);

    // skipped = every `done` row that was NOT re-queued (i.e. had
    // score >= minQuality AND a non-empty summary). We derive it
    // instead of running a second SELECT so the math is consistent
    // with the queue query above.
    const reQueuedDoneApg = queueApg.filter((r) => r.wasDone).length;
    const reQueuedDoneArpg = queueArpg.filter((r) => r.wasDone).length;
    const skippedApg = Math.max(0, totalDoneApg - reQueuedDoneApg);
    const skippedArpg = Math.max(0, totalDoneArpg - reQueuedDoneArpg);

    for (const row of queueApg) {
      void this.documentAnalysisService
        .processAttachment('project-group', row.id, user.userId)
        .catch((e) =>
          this.logger.error(
            `[backfill][project-group/${row.id}] ${(e as Error).message}`,
          ),
        );
    }
    for (const row of queueArpg) {
      void this.documentAnalysisService
        .processAttachment('revised-project-group', row.id, user.userId)
        .catch((e) =>
          this.logger.error(
            `[backfill][revised-project-group/${row.id}] ${(e as Error).message}`,
          ),
        );
    }

    const queued = queueApg.length + queueArpg.length;
    const skipped = skippedApg + skippedArpg;

    this.logger.log(
      `[backfill] user=${user.userId} minQuality=${minQuality} queued=${queued} skipped=${skipped} ` +
        `(apg: queue=${queueApg.length} skip=${skippedApg}; arpg: queue=${queueArpg.length} skip=${skippedArpg})`,
    );

    return {
      queued,
      skipped,
      byKind: {
        projectGroup: queueApg.length,
        revisedProjectGroup: queueArpg.length,
      },
    };
  }

  /**
   * Fetches every row that should be (re-)queued for analysis:
   *   - ai_status = 'pending'                                              → fresh backlog
   *   - ai_status = 'done' AND (ai_summary IS NULL OR length = 0
   *       OR ai_extraction_quality_score IS NULL
   *       OR ai_extraction_quality_score < :minQuality)                   → low-quality re-run
   *
   * Returns rows with `wasDone` so the caller can compute the `skipped`
   * counter without a second SELECT.
   */
  private async selectQueueable(
    repo:
      | Repository<AttachmentProjectGroup>
      | Repository<AttachmentRevisedProjectGroup>,
    minQuality: number,
  ): Promise<Array<{ id: string; wasDone: boolean }>> {
    const qb = repo
      .createQueryBuilder('a')
      .select(['a.id AS id', 'a.ai_status AS ai_status'])
      .where('a.deleted_at IS NULL')
      .andWhere(
        new Brackets((qb2) => {
          qb2
            .where('a.ai_status = :pending', { pending: 'pending' })
            .orWhere(
              new Brackets((qb3) => {
                qb3
                  .where('a.ai_status = :done', { done: 'done' })
                  .andWhere(
                    new Brackets((qb4) => {
                      qb4
                        .where('a.ai_summary IS NULL')
                        .orWhere("a.ai_summary = ''")
                        .orWhere('a.ai_extraction_quality_score IS NULL')
                        .orWhere(
                          'a.ai_extraction_quality_score < :minQ',
                          { minQ: minQuality },
                        );
                    }),
                  );
              }),
            );
        }),
      );

    const rows = await qb.getRawMany<{ id: string; ai_status: string }>();
    return rows.map((r) => ({ id: r.id, wasDone: r.ai_status === 'done' }));
  }

  /** Total count of `done` rows (alive) — used to derive `skipped`. */
  private async countDone(
    repo:
      | Repository<AttachmentProjectGroup>
      | Repository<AttachmentRevisedProjectGroup>,
  ): Promise<number> {
    return (repo as Repository<AttachmentProjectGroup>).count({
      where: { aiStatus: 'done', deletedAt: IsNull() },
    });
  }
}
