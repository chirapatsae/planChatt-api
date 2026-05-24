import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * engagement_download_events — append-only PDF download log.
 *
 * Per CLAUDE.md §17.3 audit-separation: `development_plan_id` and
 * `source_id` are plain UUIDs, NO foreign key to plan / revision
 * tables. Every successful PDF stream initiation writes one row.
 *
 * `device_id` is OPTIONAL — direct browser hits on a shared download
 * URL won't carry the engagement header. Counter increments anyway
 * (book-level signal, not device-level).
 *
 * PDPA: IP + User-Agent are NEVER stored here.
 */
@Entity('engagement_download_events')
@Index('ix_engagement_downloads_plan', ['developmentPlanId'])
export class EngagementDownloadEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'development_plan_id', type: 'uuid' })
  developmentPlanId: string;

  @Column({ name: 'source_type', type: 'varchar', length: 32 })
  sourceType: 'main_plan' | 'edit_revision' | 'change_revision';

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId: string;

  @Column({ name: 'version_number', type: 'int' })
  versionNumber: number;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt: Date;
}
