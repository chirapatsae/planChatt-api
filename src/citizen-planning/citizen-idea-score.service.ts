import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CitizenPost } from '../citizen-engagement/entities/citizen-post.entity';
import { CitizenIdeaScoreSnapshot } from './entities/citizen-idea-score-snapshot.entity';

/** One point of an idea's score trend (date-only + absolute 0-100 scores). */
export interface ScorePoint {
  date: string;
  demand: number;
  momentum: number;
}

/* ── ABSOLUTE scoring anchors — MUST mirror the FE B1 formula in
 * `frontend/src/page/executive/citizenIdeaInsights/ideaBoardData.ts`
 * (`DEMAND_ENGAGEMENT_REF` / `MOMENTUM_VELOCITY_REF` / `logScore` /
 * `engagementOf`) so the stored trend equals the live score the executive sees.
 * Engagement uses the CACHED totals `heartCount` (== reactionCount) +
 * 2×`commentCount`, the same fields the FE reads — no weighted-by-type source
 * on the BE, and consistency beats the finer signal. ── */
const DEMAND_ENGAGEMENT_REF = 1000;
const MOMENTUM_VELOCITY_REF = 50;

const logScore = (value: number, ref: number): number => {
  if (value <= 0) return 0;
  const s = Math.log1p(value) / Math.log1p(ref);
  return Math.max(0, Math.min(100, Math.round(s * 100)));
};

/**
 * CitizenIdeaScoreService — B2 trend layer. Persists a daily absolute-score
 * snapshot per idea (cron) and serves the per-idea history (+ a live "today"
 * point) for the executive detail sparkline.
 *
 * §17.2 advisory / §17.3 isolation — writes ONLY `citizen_idea_score_snapshots`;
 * never `tracking_status`, never a project table, no citizen identity stored.
 */
@Injectable()
export class CitizenIdeaScoreService {
  private readonly logger = new Logger(CitizenIdeaScoreService.name);

  constructor(
    @InjectRepository(CitizenIdeaScoreSnapshot)
    private readonly snapshotRepo: Repository<CitizenIdeaScoreSnapshot>,
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
  ) {}

  /** Calendar day (Asia/Bangkok), 'YYYY-MM-DD'. */
  private today(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  }

  private computeScore(
    heartCount: number,
    commentCount: number,
    createdAt: Date,
  ): { engagement: number; demand: number; momentum: number } {
    const engagement = heartCount + commentCount * 2;
    // Trailing `|| 1` guards a malformed createdAt (Math.max(1, NaN) → NaN,
    // NaN || 1 → 1) so a bad date can never poison momentum with NaN. Mirrors
    // the FE guard in ideaBoardData.ts.
    const ageDays =
      Math.max(1, (Date.now() - new Date(createdAt).getTime()) / 86_400_000) || 1;
    const velocity = engagement / ageDays;
    return {
      engagement,
      demand: logScore(engagement, DEMAND_ENGAGEMENT_REF),
      momentum: logScore(velocity, MOMENTUM_VELOCITY_REF),
    };
  }

  /**
   * Daily snapshot of every visible idea. Idempotent per (ideaId, day) via the
   * unique index — a same-day re-run just refreshes the row. Runs 01:30
   * Asia/Bangkok.
   */
  @Cron('30 1 * * *', { timeZone: 'Asia/Bangkok' })
  async snapshotAll(): Promise<{ count: number }> {
    const posts = await this.postRepo.find({
      where: { postKind: 'idea', moderationState: 'visible' },
      select: ['id', 'heartCount', 'commentCount', 'createdAt'],
    });
    if (posts.length === 0) return { count: 0 };

    const snapshotDate = this.today();
    const rows = posts.map((p) => ({
      ideaId: p.id,
      snapshotDate,
      ...this.computeScore(p.heartCount, p.commentCount, p.createdAt),
    }));

    await this.snapshotRepo.upsert(rows, {
      conflictPaths: ['ideaId', 'snapshotDate'],
      skipUpdateIfNoValuesChanged: true,
    });
    this.logger.log(`[IdeaScore] snapshot ${rows.length} ideas for ${snapshotDate}`);
    return { count: rows.length };
  }

  /**
   * Per-idea history for the sparkline: stored daily points (oldest first) PLUS
   * a freshly-computed "today" point (so the chart is non-empty and current even
   * before the cron has run today). Pure read — persists nothing.
   */
  async getHistory(ideaId: string): Promise<ScorePoint[]> {
    const stored = await this.snapshotRepo.find({
      where: { ideaId },
      order: { snapshotDate: 'ASC' },
    });
    const points: ScorePoint[] = stored.map((s) => ({
      date: s.snapshotDate,
      demand: s.demand,
      momentum: s.momentum,
    }));

    const post = await this.postRepo.findOne({
      where: { id: ideaId, postKind: 'idea', moderationState: 'visible' },
      select: ['id', 'heartCount', 'commentCount', 'createdAt'],
    });
    if (post) {
      const today = this.today();
      const live = this.computeScore(
        post.heartCount,
        post.commentCount,
        post.createdAt,
      );
      const todayPoint: ScorePoint = {
        date: today,
        demand: live.demand,
        momentum: live.momentum,
      };
      // Replace a same-day stored point with the live value, else append.
      const last = points[points.length - 1];
      if (last && last.date === today) points[points.length - 1] = todayPoint;
      else points.push(todayPoint);
    }

    return points;
  }
}
