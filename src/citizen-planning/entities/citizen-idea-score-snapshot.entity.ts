import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * CitizenIdeaScoreSnapshot — one daily point of an idea's ABSOLUTE demand /
 * momentum score (B2 trend). A background job writes one row per idea per day;
 * the executive detail view reads the series to draw a "ดีมานด์ย้อนหลัง"
 * sparkline. Because the B1 score is absolute (fixed log anchors, not relative
 * to the loaded set), these points are comparable across days.
 *
 * CLAUDE.md compliance:
 *  - §17.2 ADVISORY ONLY — a read-derived analytics snapshot. It writes NO
 *    `tracking_status`, gates NO workflow, and alters NO permission.
 *  - §17.3 ISOLATION — `citizen_*` advisory namespace. NO FK into any project
 *    table; `ideaId` references `citizen_post.id` BY VALUE (plain uuid, no FK).
 *    No citizen identity is stored — only the idea id + numeric scores.
 */
@Entity('citizen_idea_score_snapshots')
@Index('uq_citizen_idea_score_idea_date', ['ideaId', 'snapshotDate'], {
  unique: true,
})
export class CitizenIdeaScoreSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** citizen_post.id referenced BY VALUE (§17.3 — plain uuid, no FK). */
  @Column({ name: 'idea_id', type: 'uuid' })
  ideaId: string;

  /** Calendar day of the snapshot (date-only). */
  @Column({ name: 'snapshot_date', type: 'date' })
  snapshotDate: string;

  /** Absolute demand 0-100 (log-anchored) at snapshot time. */
  @Column({ name: 'demand', type: 'int' })
  demand: number;

  /** Absolute momentum 0-100 (log-anchored) at snapshot time. */
  @Column({ name: 'momentum', type: 'int' })
  momentum: number;

  /** Raw weighted engagement (reactions + 2×comments) at snapshot time. */
  @Column({ name: 'engagement', type: 'int' })
  engagement: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
