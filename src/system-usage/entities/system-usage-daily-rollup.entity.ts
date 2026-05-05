/**
 * system_usage_daily_rollups — W107 nightly rollup table.
 *
 * Source-of-truth: docs/tasks/wave107/W107-DB-PR1-ROLLUP-SCHEMA.md (§8.1).
 * Purpose: pre-aggregated daily activity counts for the System Usage
 * Statistics page. Populated by the W107-BE-PR1 cron and read by the
 * W107-BE-PR2 stats API.
 *
 * Advisory metadata; not for workflow gating (CLAUDE.md §17.2). No row in
 * this table can change a transition's authority, ownership, or eligibility.
 *
 * Audit separation (CLAUDE.md §17.3):
 *   - NO foreign key to project_groups, revised_project_groups,
 *     supplement_project_groups, development_plan, development_plan_revision,
 *     development_plan_supplement, tracking_status, ai_usage_logs,
 *     notification_email_logs, notification_line_logs, comments, or users.
 *   - amphoe_id and government_agency_id are stored as bare scalar
 *     references (no relation declared) so cascade-deletes and §14.6
 *     rollback row removals do not cascade into this rollup.
 *   - The rollup is a derived view; it can be recomputed from upstream
 *     audit tables at any time, so it owns no immutable history of its
 *     own and needs no audit trail.
 *
 * Lineage compatibility (CLAUDE.md §14, §15):
 *   - This table holds aggregate counts only. Locked rows / frozen books
 *     do not interact with this table — reads of upstream sources by
 *     BE-PR1 are §17.6 read-only compute and are explicitly allowed.
 *
 * Idempotency / UPSERT key:
 *   - The cron writes one row per (bucket_date, role, amphoe_id,
 *     government_agency_id). amphoe_id and/or government_agency_id are
 *     NULL for composite "all-amphoes" / "all-agencies" rows.
 *   - Postgres UNIQUE treats NULL as distinct, so a vanilla composite
 *     UNIQUE will not catch duplicate (NULL, NULL) tuples. To enforce
 *     a single canonical row per logical key, BE-PR1 will UPSERT using
 *     a COALESCE-based ON CONFLICT target backed by the expression
 *     unique index declared below (see DECISION block in the W107-DB-PR1
 *     report).
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('system_usage_daily_rollups')
// Range scans on bucket_date (timeseries / DAU trend / role-distribution).
@Index('ix_sudr_bucket_date', ['bucketDate'])
// Role-filtered timeseries.
@Index('ix_sudr_role_bucket_date', ['role', 'bucketDate'])
// Amphoe-filtered timeseries.
@Index('ix_sudr_amphoe_bucket_date', ['amphoeId', 'bucketDate'])
// Agency-filtered timeseries.
@Index('ix_sudr_agency_bucket_date', ['governmentAgencyId', 'bucketDate'])
export class SystemUsageDailyRollup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Day boundary in ICT (Asia/Bangkok). Stored as DATE so timezone
   * conversion lives in BE-PR1 (cron) and not in this row.
   */
  @Column({ type: 'date', name: 'bucket_date' })
  bucketDate: string;

  /**
   * Canonical role name. Whitelist enforced at BE-PR1 write time:
   *   'user' | 'staff' | 'admin' | 'super-admin' | 'c-level'
   *
   * NOT NULL — the rollup grain always segments by role. A composite
   * "all roles" row is NOT supported in this schema; BE-PR2 sums across
   * roles at read time.
   */
  @Column({ type: 'varchar', length: 32, name: 'role' })
  role: string;

  /**
   * Bare reference to amphoes.id. NULL for the "all amphoes" segment
   * within a (bucket_date, role) tuple. Type matches amphoes.id
   * (varchar — see backend/src/amphoes/entities/amphoe.entity.ts).
   *
   * NO FK declared (§17.3). NO relation property exposed.
   */
  @Column({ type: 'varchar', length: 32, name: 'amphoe_id', nullable: true })
  amphoeId: string | null;

  /**
   * Bare reference to government_agencies.id. NULL for the "all
   * agencies" segment within a (bucket_date, role) tuple. Type matches
   * government_agencies.id (varchar / numeric-as-string — see
   * backend/src/government-agencies/entities/government-agency.entity.ts).
   *
   * NO FK declared (§17.3). NO relation property exposed.
   */
  @Column({
    type: 'varchar',
    length: 32,
    name: 'government_agency_id',
    nullable: true,
  })
  governmentAgencyId: string | null;

  /**
   * Distinct users with any meaningful activity that day. BE-PR1 derives
   * this from users.last_seen_at (W106) by ICT-day bucketing.
   */
  @Column({ type: 'int', name: 'dau_count', default: 0 })
  dauCount: number;

  /**
   * Distinct users whose last_seen_at fell in the bucket day. Acts as a
   * login proxy until a real auth-event capture exists (deferred per
   * plan §11 risks).
   */
  @Column({ type: 'int', name: 'login_count', default: 0 })
  loginCount: number;

  /**
   * Workflow transitions written to tracking_status that day. Read-only
   * cross-link; this column does NOT replace tracking_status as the
   * audit source of truth (§12).
   */
  @Column({ type: 'int', name: 'transition_count', default: 0 })
  transitionCount: number;

  /**
   * Comments authored that day. Cross-link from comments table.
   */
  @Column({ type: 'int', name: 'comment_count', default: 0 })
  commentCount: number;

  /**
   * PDF exports that day. Best-effort — defaults to 0 if no audit row
   * exists upstream (BE-PR1 documents the source it uses).
   */
  @Column({ type: 'int', name: 'pdf_export_count', default: 0 })
  pdfExportCount: number;

  /**
   * AI invocations that day. Cross-link from ai_usage_logs. Duplicates
   * data already aggregated by AI usage stats — kept here for the KPI
   * strip; recomputable, not authoritative (§17.3).
   */
  @Column({ type: 'int', name: 'ai_invocation_count', default: 0 })
  aiInvocationCount: number;

  /**
   * Notification deliveries that day. Cross-link from
   * notification_email_logs + notification_line_logs.
   */
  @Column({ type: 'int', name: 'notification_count', default: 0 })
  notificationCount: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
