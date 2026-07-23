import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * citizen_story_views — one VIEW row per viewer per ephemeral 24h story.
 *
 * Records that a citizen has seen a story so the story owner's audience page
 * ("who viewed my story") can render, and so a viewer's own seen/unseen ring
 * state can be derived. The view is FIRST-VIEW-time: the UNIQUE
 * (story_id, viewer_identity_id) makes the write upsert-idempotent — a repeat
 * open keeps the original `viewed_at` and never inflates the count.
 *
 * §17.3 isolation: this table lives entirely in the `citizen_*` namespace.
 * BOTH `story_id` and `viewer_identity_id` are PLAIN uuid columns with NO
 * foreign key / relation (mirrors citizen_password_reset_tokens /
 * citizen_audit_logs) — a PDPA erase (status='deleted') NEVER cascades here,
 * and the 24h retention sweep purges view rows independently. There is NO FK
 * into any project table / users / work_history / tracking_status.
 *
 * `synchronize: true` auto-creates this table + columns + the plain indexes in
 * dev; prod parity is via a real migration + the BootstrapMigrationsService
 * allow-list (idempotent CREATE TABLE / INDEX IF NOT EXISTS).
 */
@Entity('citizen_story_views')
// One view row per viewer per story — first-view time kept, upsert-idempotent.
@Index('uq_citizen_story_view_story_viewer', ['storyId', 'viewerIdentityId'], {
  unique: true,
})
// Owner audience page — recent viewers of a story first.
@Index('ix_citizen_story_view_story_viewed', ['storyId', 'viewedAt'])
// DSAR erase — purge all views by a given viewer.
@Index('ix_citizen_story_view_viewer', ['viewerIdentityId'])
export class CitizenStoryView {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** citizen_story.id — PLAIN uuid, NO FK (§17.3). */
  @Column({ name: 'story_id', type: 'uuid' })
  storyId: string;

  /** citizen_identities.id of the viewer — PLAIN uuid, NO FK (§17.3). */
  @Column({ name: 'viewer_identity_id', type: 'uuid' })
  viewerIdentityId: string;

  /** First-view timestamp; UNIQUE keeps it stable across repeat opens. */
  @CreateDateColumn({ name: 'viewed_at', type: 'timestamptz' })
  viewedAt: Date;
}
