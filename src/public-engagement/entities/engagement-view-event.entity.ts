import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * engagement_view_events — anonymous view tracking, debounced per
 * (target [+ version], device, day).
 *
 * Per CLAUDE.md §17.3 audit-separation: `target_id` is a plain UUID,
 * NO foreign key to project / plan tables. The
 * `(target_kind, target_id, source_type, source_id, version_number,
 * device_id, view_date)` unique constraint implements the
 * once-per-device-per-day debounce at the DB layer.
 *
 * Wave per-version-engagement-counts (2026-06-01): the
 * `source_type` / `source_id` / `version_number` columns make a view
 * attributable to a single assembled BOOK VERSION (mirror of
 * `engagement_download_events`). They are NULLABLE — legacy plan-level
 * and project-level view rows leave them NULL and behave exactly as
 * before (the wide unique key still pins the legacy path via
 * `target_kind, target_id, device_id, view_date`; Postgres treats the
 * NULL version columns as additive, never blocking the legacy row).
 *
 * §17.3 — `source_id` is a plain UUID, NO foreign key.
 *
 * PDPA: `device_id` is an opaque client UUID. User-Agent is read for
 * bot filtering only and is NEVER stored on insert.
 */
/**
 * NOTE — the debounce UNIQUE arbiter
 * (`uq_engagement_views_target_ver_device_day`) is a COALESCE-based
 * EXPRESSION unique index owned by migration
 * `1781200000000-AddVersionDimsToViewEvents`, NOT a TypeORM-managed
 * `@Unique` decorator. A plain multi-column `@Unique` over the nullable
 * version columns would let Postgres treat NULL as distinct and break
 * the legacy once-per-(target,device,day) debounce. TypeORM cannot
 * express a COALESCE index, so the index lives in the migration and is
 * deliberately absent here — `synchronize:true` therefore leaves it
 * alone (it never tries to drop/recreate an index it doesn't know
 * about). The service's `recordView` INSERT references the SAME
 * COALESCE expression list in its `ON CONFLICT` target.
 */
@Entity('engagement_view_events')
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

  /**
   * Book source type this view is attributed to. NULL for legacy
   * plan-level / project-level views that predate per-version tracking.
   * Wave per-version-engagement-counts.
   */
  @Column({ name: 'source_type', type: 'varchar', length: 32, nullable: true })
  sourceType:
    | 'main_plan'
    | 'edit_revision'
    | 'change_revision'
    | 'supplement'
    | null;

  /**
   * Book source id (plan id / revision id / supplement id) this view is
   * attributed to. Plain UUID — §17.3 NO foreign key. NULL for legacy
   * rows.
   */
  @Column({ name: 'source_id', type: 'uuid', nullable: true })
  sourceId: string | null;

  /** Assembled book version number. NULL for legacy rows. */
  @Column({ name: 'version_number', type: 'int', nullable: true })
  versionNumber: number | null;

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
