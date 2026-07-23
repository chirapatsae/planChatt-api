import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * citizen_story_reactions — one emoji reaction per citizen per ephemeral 24h
 * story (FB-6).
 *
 * A citizen may react to a story with exactly ONE of the CLOSED-SET keys
 * (`love` | `haha` | `wow` | `sad` | `angry` | `like`). `emoji` stores the KEY,
 * NOT the rendered glyph, so the glyph can be re-skinned client-side without a
 * data migration. The UNIQUE (story_id, identity_id) enforces "one reaction per
 * citizen per story": add = insert; switch = UPDATE the key in place; un-react
 * = HARD DELETE (no soft-delete — the data is 24h-ephemeral). A DB CHECK on the
 * six keys is defense-in-depth behind the service-layer validation.
 *
 * §17.3 isolation: this table lives entirely in the `citizen_*` namespace.
 * BOTH `story_id` and `identity_id` are PLAIN uuid columns with NO foreign key
 * / relation (mirrors citizen_password_reset_tokens / citizen_audit_logs) — a
 * PDPA erase NEVER cascades here, and the 24h retention sweep purges reaction
 * rows independently. There is NO FK into any project table / users /
 * work_history / tracking_status.
 *
 * `synchronize: true` auto-creates this table + columns + the plain indexes in
 * dev; prod parity is via a real migration + the BootstrapMigrationsService
 * allow-list (idempotent CREATE TABLE / INDEX IF NOT EXISTS + the CHECK).
 */
@Entity('citizen_story_reactions')
// One reaction per citizen per story — update-in-place.
@Index('uq_citizen_story_reaction_story_identity', ['storyId', 'identityId'], {
  unique: true,
})
// Per-story emoji breakdown.
@Index('ix_citizen_story_reaction_story', ['storyId'])
// DSAR erase — purge all reactions by a given citizen.
@Index('ix_citizen_story_reaction_identity', ['identityId'])
export class CitizenStoryReaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** citizen_story.id — PLAIN uuid, NO FK (§17.3). */
  @Column({ name: 'story_id', type: 'uuid' })
  storyId: string;

  /** citizen_identities.id of the reactor — PLAIN uuid, NO FK (§17.3). */
  @Column({ name: 'identity_id', type: 'uuid' })
  identityId: string;

  /**
   * CLOSED-SET reaction key — one of `love` | `haha` | `wow` | `sad` | `angry`
   * | `like` (FB-6). Stores the KEY, not the glyph. A DB CHECK on these six
   * values is added in the migration + bootstrap allow-list.
   */
  @Column({ name: 'emoji', type: 'varchar', length: 16 })
  emoji: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
