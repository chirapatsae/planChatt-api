import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * engagement_likes — anonymous project like toggles.
 *
 * Per CLAUDE.md §17.3 audit-separation: `target_id` is a plain UUID,
 * NO foreign key to project_groups / revised_project_groups. The
 * `(target_kind, target_id, device_id)` unique constraint enforces
 * toggle idempotency on the DB layer.
 *
 * Per CLAUDE.md §14 / §18: the absence of FK guarantees that staff-led
 * rollback hard-deletes and orphan-cleanup soft-deletes do NOT cascade
 * into engagement history. Orphaned rows remain in the table but are
 * inert (the read path filters via `getPublishedPlanIds()`).
 *
 * PDPA: `device_id` is an opaque client-generated UUID — no PII bound.
 * IP and User-Agent are NEVER stored here.
 */
@Entity('engagement_likes')
@Unique('uq_engagement_likes_target_device', [
  'targetKind',
  'targetId',
  'deviceId',
])
@Index('ix_engagement_likes_target', ['targetKind', 'targetId'])
export class EngagementLike {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'target_kind', type: 'varchar', length: 32 })
  targetKind:
    | 'project_group'
    | 'revised_project_group'
    | 'supplement_project_group';

  /** No FK — see §17.3 pattern. */
  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  /** Opaque anonymous UUID from client localStorage. */
  @Column({ name: 'device_id', type: 'uuid' })
  deviceId: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt: Date;
}
