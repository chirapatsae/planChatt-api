/**
 * stats_access_log — W107 PDPA access trail for the System Usage
 * Statistics page.
 *
 * Source-of-truth: docs/tasks/wave107/W107-DB-PR1-ROLLUP-SCHEMA.md (§8.2)
 * + docs/tasks/wave107/W107-PLAN-SYSTEM-USAGE-STATS.md §7.
 * Purpose: every successful page-load and every successful
 * /v1/system-usage/* call writes a row here so that "who looked at
 * personal activity data, when, and with which filter" is auditable
 * for PDPA compliance.
 *
 * Advisory metadata; not for workflow gating (CLAUDE.md §17.2). Reading
 * stats does not influence any transition, ownership, or authority.
 *
 * Audit separation (CLAUDE.md §17.3):
 *   - NO foreign key to users, work_history, or any project / plan /
 *     tracking table.
 *   - caller_user_id, caller_work_history_id are bare uuid references
 *     so a user / work-history soft-delete does not cascade and erase
 *     the access trail.
 *   - Denormalized caller_role is captured at access time so audit
 *     remains forensically meaningful even if the caller's role
 *     changes later.
 *
 * Append-only (no soft-delete, no update path). BE-PR2 inserts; nothing
 * else writes. §17.11 — no role may rewrite or delete access-log rows.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('stats_access_log')
// "Who has been viewing stats" admin queries.
@Index('ix_sal_caller_accessed_at', ['callerUserId', 'accessedAt'])
// Recent-access scans across all callers.
@Index('ix_sal_accessed_at', ['accessedAt'])
export class StatsAccessLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Wall-clock of the access. Distinct from the inherited createdAt so
   * the read-side terminology matches "accessed at" (PDPA framing).
   */
  @CreateDateColumn({ type: 'timestamptz', name: 'accessed_at' })
  accessedAt: Date;

  /**
   * users.id of the caller. NO FK (§17.3) — soft-deleting a user must
   * not destroy the audit trail of what they accessed.
   */
  @Column({ type: 'uuid', name: 'caller_user_id' })
  callerUserId: string;

  /**
   * work_history.id of the caller's current/latest WorkHistory. §4
   * ownership is bound to WorkHistory; the access log captures it for
   * forensic completeness. NO FK (§17.3).
   *
   * Nullable defensively — a system / cron-initiated access may have
   * no WorkHistory context.
   */
  @Column({
    type: 'uuid',
    name: 'caller_work_history_id',
    nullable: true,
  })
  callerWorkHistoryId: string | null;

  /**
   * Snapshot of the caller's role at access time. Denormalized on
   * purpose — surviving role changes is the point of an audit trail.
   * Whitelist enforced at BE-PR2 write time.
   */
  @Column({ type: 'varchar', length: 32, name: 'caller_role' })
  callerRole: string;

  /**
   * Endpoint identifier. Format: 'METHOD path' (e.g.
   * 'GET /v1/system-usage/timeseries'). Truncated at 256 chars.
   */
  @Column({ type: 'varchar', length: 256, name: 'endpoint' })
  endpoint: string;

  /**
   * Filter set used by the call. Stored verbatim for "who saw what"
   * audit. PII MUST NOT be included in this payload — BE-PR2 strips
   * any free-text body fields before serializing.
   */
  @Column({ type: 'jsonb', name: 'query_params', default: () => `'{}'::jsonb` })
  queryParams: Record<string, unknown>;

  /**
   * HTTP outcome of the access. BE-PR2 currently writes 2xx only; the
   * column accepts the full range so future expansion (e.g. logging
   * 403 attempts) does not require migration.
   */
  @Column({ type: 'int', name: 'http_status' })
  httpStatus: number;

  /**
   * Caller IP. Postgres `inet` type accepts both IPv4 and IPv6.
   * Nullable — proxy / internal access may not have a meaningful IP.
   */
  @Column({ type: 'inet', name: 'request_ip', nullable: true })
  requestIp: string | null;

  /**
   * Caller User-Agent string. Free-form; nullable for non-browser
   * callers (CLI, internal cron).
   */
  @Column({ type: 'text', name: 'request_user_agent', nullable: true })
  requestUserAgent: string | null;
}
