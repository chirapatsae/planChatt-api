import { Exclude } from 'class-transformer';
import { Comment } from 'src/comments/entities/comment.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('tracking_status')
export class TrackingStatus {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  comment?: string;

  /**
   * Staff-only internal remark recorded at transition time.
   *
   * Only staff / admin / super-admin may set this field.
   * User role submissions must have this stripped to null by the service layer.
   *
   * This field is write-once: it must not be mutated after the record is created.
   *
   * CLAUDE.md §12 (Audit Rule): all mutations must be traceable.
   * CLAUDE.md §3 (Role Responsibilities): only staff-lead roles perform
   * workflow governance transitions.
   */
  @Column({ name: 'staff_remark', type: 'text', nullable: true, default: null })
  staffRemark?: string | null;

  @DeleteDateColumn({ nullable: true })
  @Exclude()
  deletedAt?: Date;

  @ManyToOne(
    () => WorkHistory,
    (workHistory) => workHistory.deletorTrackingStatus,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'deleted_by' })
  deletedBy: WorkHistory;

  @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
  createAt: Date;

  @ManyToOne(
    () => WorkHistory,
    (workHistory) => workHistory.creatorTrackingStatus,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;

  @ManyToOne(
    () => ProjectGroup,
    (projectGroup) => projectGroup.trackingStatus,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'project_group_id' })
  projectGroupId: ProjectGroup | null;

  @ManyToOne(
    () => RevisedProjectGroup,
    (revisedProjectGroup) => revisedProjectGroup.trackingStatus,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'revised_project_group_id' })
  revisedProjectGroupId: RevisedProjectGroup | null;

  @ManyToOne(
    () => SupplementProjectGroup,
    (supplementProjectGroup) => supplementProjectGroup.trackingStatus,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'supplement_project_group_id' })
  supplementProjectGroupId: SupplementProjectGroup | null;

  @ManyToOne(() => Status, (status) => status.trackingStatus, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'status_id' })
  statusId: Status;

  @Column({ name: 'is_latest', default: true })
  isLatest: boolean;

  @OneToMany(() => Comment, (comment) => comment.trackingStatusId, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  comments: Comment[];
}
