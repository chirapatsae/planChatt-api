import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * engagement_view_events — anonymous view tracking, debounced per
 * (target, device, day).
 *
 * Per CLAUDE.md §17.3 audit-separation: `target_id` is a plain UUID,
 * NO foreign key to project / plan tables. The
 * `(target_kind, target_id, device_id, view_date)` unique constraint
 * implements the once-per-device-per-day debounce at the DB layer.
 *
 * PDPA: `device_id` is an opaque client UUID. User-Agent is read for
 * bot filtering only and is NEVER stored on insert.
 */
@Entity('engagement_view_events')
@Unique('uq_engagement_views_target_device_day', [
  'targetKind',
  'targetId',
  'deviceId',
  'viewDate',
])
@Index('ix_engagement_views_target', ['targetKind', 'targetId'])
export class EngagementViewEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'target_kind', type: 'varchar', length: 32 })
  targetKind:
    | 'project_group'
    | 'revised_project_group'
    | 'supplement_project_group'
    | 'development_plan';

  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId: string;

  /**
   * Calendar date in the application's reference timezone
   * (Asia/Bangkok). One row per device per target per calendar day.
   */
  @Column({ name: 'view_date', type: 'date' })
  viewDate: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt: Date;
}
