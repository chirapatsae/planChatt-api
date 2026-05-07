import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AiExecutiveMessage } from './ai-executive-message.entity';

/**
 * ai_executive_conversations — Wave 44 Executive AI Chat container.
 *
 * CLAUDE.md references:
 *
 *   - §17.3 Audit separation (CRITICAL). `owner_work_history_id` is a
 *     plain uuid — NO foreign key to `work_histories`. This mirrors the
 *     precedent set by `ai_pre_submit_snapshots.submitted_by_work_history_id`
 *     and `ai_staff_review_runs.reviewer_work_history_id`, and guarantees
 *     that any hypothetical WorkHistory row mutation does NOT cascade
 *     into this chat history.
 *
 *   - §4 Ownership. `ownerWorkHistoryId` is the canonical scope key for
 *     per-query filtering; the service layer (BE-W44-02) MUST enforce
 *     `ownerWorkHistoryId === caller.currentWorkHistory.id` on every
 *     read and every write.
 *
 *   - §17.11 No role exemption. Ownership is integrity, not permission;
 *     no role (including super-admin) may cross-read another owner's
 *     conversation.
 *
 * Soft delete: `deletedAt` is populated when a user archives the
 * conversation. The partial index on `(owner_work_history_id,
 * updated_at DESC) WHERE deleted_at IS NULL` keeps the owner's active
 * conversation list ordered by recency.
 */
@Entity('ai_executive_conversations')
@Index('ix_ai_executive_conversations_owner_updated', [
  'ownerWorkHistoryId',
  'updatedAt',
])
export class AiExecutiveConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * WorkHistory.id of the owning user (§4). NOT a foreign key (§17.3).
   */
  @Column({ name: 'owner_work_history_id', type: 'uuid' })
  ownerWorkHistoryId: string;

  @Column({
    name: 'title',
    type: 'varchar',
    length: 200,
    default: 'บทสนทนาใหม่',
  })
  title: string;

  /**
   * Wave 51 DB-W51-01 — discriminator for how the current title was
   * produced. Drives the BE-W51-02 auto-title idempotency gate
   * (compare-and-set: only write when `titleSource === 'default-placeholder'`).
   *
   * Domain (application-enforced, NO DB CHECK):
   *   - 'default-placeholder' — row was just inserted with the literal
   *     Thai placeholder `'บทสนทนาใหม่'`
   *   - 'llm-auto'            — background auto-title wrote a content-aware title
   *   - 'user-rename'         — owner clicked the sidebar rename UI
   *
   * CLAUDE.md references:
   *   - §12 Audit Rule — title metadata is NOT a workflow status; no
   *     `tracking_status` row is written when this column changes.
   *   - §17.3 Audit separation — no FK added; `ai_executive_conversations`
   *     remains FK-isolated to `ai_*`. Neither `title_source` nor
   *     `title_generated_at` references any other table.
   *   - §17.11 No role exemption — the enum domain is integrity, not
   *     permission. No role (including super-admin) may coerce a
   *     non-member value; the service layer (BE-W51-02) is the single
   *     writer.
   *
   * See also: `docs/reports/wave51/WAVE51_AUTO_TITLE_DESIGN.md` §6.
   */
  @Column({
    name: 'title_source',
    type: 'varchar',
    length: 32,
    default: 'default-placeholder',
  })
  titleSource: 'default-placeholder' | 'llm-auto' | 'user-rename';

  /**
   * Wave 51 DB-W51-01 — timestamp of the most recent title write.
   * NULL while the title is still the `'default-placeholder'`
   * literal placeholder; populated on first auto-title or user-rename
   * persist.
   *
   * CLAUDE.md references:
   *   - §12 — no `tracking_status` coupling
   *   - §17.3 — no FK
   *
   * See also: `docs/reports/wave51/WAVE51_AUTO_TITLE_DESIGN.md` §6.
   */
  @Column({
    name: 'title_generated_at',
    type: 'timestamptz',
    nullable: true,
  })
  titleGeneratedAt: Date | null;

  @Column({
    name: 'model',
    type: 'varchar',
    length: 64,
    default: 'gpt-4o',
  })
  model: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    nullable: true,
  })
  updatedAt: Date | null;

  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamptz',
    nullable: true,
  })
  deletedAt: Date | null;

  /**
   * Intra-AI relation (§17.3) — the ONLY FK in this feature's schema
   * lives on `AiExecutiveMessage.conversationId` with ON DELETE CASCADE.
   * No foreign key leaves the `ai_*` boundary.
   */
  @OneToMany(() => AiExecutiveMessage, (message) => message.conversation)
  messages: AiExecutiveMessage[];
}
