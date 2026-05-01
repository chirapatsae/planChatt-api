import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * line_user_bindings — Wave 86 LINE chatbot integration.
 *
 * Maps a LINE user (`lineUserId`) to a Project Bank `User`. The binding
 * is created when a user completes the LINE Login OIDC flow on the
 * profile page, and is soft-unlinked (NOT hard-deleted) when the user
 * clicks "ยกเลิกการเชื่อมต่อ".
 *
 * CLAUDE.md references:
 *
 *   - §17.3 Audit separation. This table preserves history via the
 *     soft-unlink pattern (`unlinkedAt`) instead of hard delete. The
 *     unique partial index on `(lineUserId) WHERE unlinkedAt IS NULL`
 *     enforces "at most one ACTIVE binding per LINE user globally" while
 *     still allowing historical (soft-unlinked) rows to coexist for the
 *     same `lineUserId` — supporting re-link semantics and audit
 *     forensics.
 *
 *   - §17.11 No role exemption. Binding ownership is integrity, not
 *     permission. No role (including super-admin) may cross-bind another
 *     user's LINE id; the service layer (W86-BE-LINE-LOGIN-*) enforces
 *     OIDC-verified `lineUserId` uniqueness on every link attempt.
 *
 *   - §14 Lineage immutability. This binding is NOT a project row, so
 *     §14 does NOT apply. The FK to `users` uses `ON DELETE CASCADE` —
 *     if a user is hard-deleted, their LINE bindings disappear with
 *     them, which is the correct behavior for a personal-data table.
 *
 * Privacy / PDPA notes:
 *   - `displayName` and `pictureUrl` are SNAPSHOTS captured at link
 *     time. They are NOT continuously synced from LINE. This minimizes
 *     personal-data exposure to the bare minimum required for chatbot
 *     UX.
 *   - `lastSeenAt` is bumped on each webhook event for the binding so
 *     operators can audit dormant bindings.
 *   - Hard delete via FK CASCADE only happens when the underlying User
 *     row is hard-deleted (PDPA right-to-erasure cascade); ordinary
 *     unlink uses the `unlinkedAt` soft-delete column.
 */
@Entity('line_user_bindings')
@Index('idx_line_user_bindings_active_unique', ['lineUserId'], {
  unique: true,
  where: '"unlinked_at" IS NULL',
})
@Index('idx_line_user_bindings_user_active', ['userId'], {
  where: '"unlinked_at" IS NULL',
})
@Index('idx_line_user_bindings_line_user_id', ['lineUserId'])
export class LineUserBinding {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Project Bank User id. FK with ON DELETE CASCADE — when the User
   * row is hard-deleted (PDPA erasure path), the binding is removed
   * with it. Ordinary user-initiated unlink does NOT delete the row;
   * it sets `unlinkedAt` instead (§17.3 audit preservation).
   */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /**
   * LINE U-prefixed user id (e.g. `U4af4980629...`) — 33 chars typical;
   * column sized to 64 to allow for any future LINE id format change
   * without a schema migration.
   */
  @Column({ name: 'line_user_id', type: 'varchar', length: 64 })
  lineUserId: string;

  /**
   * Snapshot at link time (NOT continuously synced from LINE). The
   * webhook layer MUST NOT auto-update this column — staleness is the
   * intended behavior to limit personal-data exposure.
   */
  @Column({
    name: 'display_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  displayName: string | null;

  @Column({
    name: 'picture_url',
    type: 'varchar',
    length: 1024,
    nullable: true,
  })
  pictureUrl: string | null;

  @CreateDateColumn({ name: 'linked_at', type: 'timestamptz' })
  linkedAt: Date;

  /**
   * Soft unlink — set when the user clicks "ยกเลิกการเชื่อมต่อ" on the
   * profile page. The unique partial index on `(line_user_id) WHERE
   * unlinked_at IS NULL` allows the same LINE id to be re-linked after
   * unlink without violating uniqueness, while preserving the audit
   * trail (§17.3).
   */
  @Column({ name: 'unlinked_at', type: 'timestamptz', nullable: true })
  unlinkedAt: Date | null;

  /**
   * Updated on every webhook event from this binding (last activity).
   * Used by operators to audit dormant bindings; not exposed to end
   * users.
   */
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  /**
   * W86-BE-LINE-AI-BRIDGE — persistent LINE-channel conversation id
   * (`ai_executive_conversations.id`).
   *
   * Each LINE-bound user has ONE rolling AI executive chat conversation
   * that LINE messages stream into. The id is stored here (NOT on the
   * conversation row) for two reasons:
   *
   *   1. `ai_executive_conversations` has no `channel` discriminator
   *      column; carrying the LINE-channel marker on the binding row
   *      avoids a schema change to a FK-isolated AI table (§17.3 audit
   *      separation — `ai_*` boundary stays clean).
   *
   *   2. Lookup is keyed by `lineUserId → binding → conversationId` in a
   *      single indexed read on `idx_line_user_bindings_active_unique`,
   *      avoiding a JOIN into the AI module from the LINE webhook hot
   *      path.
   *
   * Plain UUID — NO foreign key to `ai_executive_conversations`. Per
   * §17.3, the AI tables MUST NOT be referenced by FKs from outside the
   * `ai_*` boundary. If the underlying conversation is hard-deleted (PDPA
   * erasure), this column points at a no-longer-existing id; the bridge
   * service detects the dangling reference and creates a fresh
   * conversation transparently.
   *
   * NULL until the first text-message event for this binding triggers
   * conversation creation.
   */
  @Column({
    name: 'line_ai_conversation_id',
    type: 'uuid',
    nullable: true,
  })
  lineAiConversationId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
