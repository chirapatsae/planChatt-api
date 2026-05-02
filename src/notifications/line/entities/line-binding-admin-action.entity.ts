import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';

/**
 * line_binding_admin_actions — Wave 97 admin-action audit table.
 *
 * Source of truth:
 *   - docs/tasks/wave97/W97-MIGRATION.md (schema)
 *   - docs/tasks/wave97/W97-API-BINDINGS.md (reveal write contract)
 *   - docs/tasks/wave97/W97-API-FORCE-UNLINK.md (force-unlink write contract)
 *   - Migration: `backend/src/migrations/1777680000000-W97NotificationOpsSchema.ts`
 *
 * Audit row written every time a super-admin performs one of:
 *   - `action='reveal'` — unmasking a single LINE binding's `lineUserId`
 *     for compliance / support purposes (W97-API-BINDINGS owns the write).
 *   - `action='force-unlink'` — administratively soft-unlinking another
 *     user's LINE binding (W97-API-FORCE-UNLINK owns the write).
 *
 * CLAUDE.md references:
 *   - §4.1 — these are central-authority operational actions; they do NOT
 *     gate any workflow transition and MUST NOT be confused with §4.1
 *     workflow authority.
 *   - §12 — admin actions on bindings MUST NOT touch `tracking_status`.
 *     This audit table is the canonical record for binding-admin events.
 *   - §14 / §14.6 — rollback hard-deletes must NOT cascade into operational
 *     audit. NO FK from this table into any project table.
 *   - §17.3 — audit isolation. FKs are limited to:
 *       * `users(id)` for the actor (ON DELETE SET NULL — preserves audit
 *         when the actor is hard-deleted under PDPA erasure).
 *       * `line_user_bindings(id)` for the target binding (ON DELETE
 *         CASCADE — soft-unlink is the canonical lifecycle, hot-delete is
 *         forbidden by policy so the cascade is dormant).
 *     `target_user_id` is denormalized for query speed and intentionally
 *     has no FK so audit isolation is preserved if a future user
 *     hard-delete path is ever introduced.
 *   - §17.11 — even super-admin reveal / force-unlink writes flow through
 *     this audit row; there is no permission-bypass path.
 *   - W83 — the binding row stores the raw `lineUserId`; this audit row
 *     references the binding by id and intentionally does NOT duplicate
 *     the raw `lineUserId` into a second column. Server logs MUST mask
 *     `lineUserId` via the `shortHash` helper before emitting any line.
 *
 * CHECK constraints (enforced at the DB layer by W97-MIGRATION):
 *   - `ck_lba_actions_action`: `action IN ('force-unlink', 'reveal')`
 *   - `ck_lba_actions_reason_required_for_force_unlink`:
 *       `action = 'force-unlink' IMPLIES reason IS NOT NULL AND
 *        length(reason) BETWEEN 12 AND 200`
 *     (`reveal` may carry a non-null `reason` carrying the operator's
 *     purpose / justification text — application layer enforces 12..200
 *     chars on reveal; the DB CHECK is one-sided.)
 */
@Entity('line_binding_admin_actions')
@Index('ix_lba_actions_actor_created', ['actorUserId', 'createdAt'])
@Index('ix_lba_actions_target_binding', ['targetBindingId', 'createdAt'])
@Index('ix_lba_actions_action_created', ['action', 'createdAt'])
export class LineBindingAdminAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Discriminator. Constrained at the DB layer to {'force-unlink', 'reveal'}
   * via the `ck_lba_actions_action` CHECK constraint.
   */
  @Column({ type: 'text' })
  action: 'force-unlink' | 'reveal';

  /**
   * Actor (the super-admin who performed the action). FK with
   * `ON DELETE SET NULL` so audit history survives PDPA erasure of the
   * actor's user row.
   */
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User | null;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId: string | null;

  /**
   * Actor's WorkHistory id at the time of the action. Plain UUID (no FK)
   * because WorkHistory is an archival table per CLAUDE.md §4 — a stale
   * id is acceptable; we only need the snapshot of the actor's
   * organizational context at action time.
   */
  @Column({ name: 'actor_work_history_id', type: 'uuid', nullable: true })
  actorWorkHistoryId: string | null;

  /**
   * Subject of the action — the LINE binding row. Cascade-delete is
   * dormant because hot-delete of bindings is forbidden by policy
   * (soft-unlink via `unlinkedAt` is the canonical lifecycle, see
   * `LineUserBinding`).
   */
  @ManyToOne(() => LineUserBinding, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'target_binding_id' })
  targetBinding: LineUserBinding;

  @Column({ name: 'target_binding_id', type: 'uuid' })
  targetBindingId: string;

  /**
   * Denormalized from the binding's `userId` at write time for query
   * speed. Intentionally has no FK so audit-isolation invariants hold
   * even if a future user-hard-delete path is added.
   */
  @Column({ name: 'target_user_id', type: 'uuid' })
  targetUserId: string;

  /**
   * Operator-supplied free text:
   *   - REQUIRED for `action='force-unlink'` (12..200 chars; enforced by
   *     `ck_lba_actions_reason_required_for_force_unlink`).
   *   - For `action='reveal'`, this column carries the operator's
   *     purpose / justification text (12..200 chars enforced at the
   *     application layer per W97-API-BINDINGS spec §3).
   *
   * Untrusted operator input — downstream consumers MUST escape on
   * render.
   */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /**
   * Diagnostic operator metadata captured from the request transport.
   * `inet` column on Postgres; mapped as a string in TypeORM. NULL when
   * the request did not surface an IP (e.g. unit-test paths).
   */
  @Column({ name: 'request_ip', type: 'inet', nullable: true })
  requestIp: string | null;

  @Column({ name: 'request_user_agent', type: 'text', nullable: true })
  requestUserAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
