import { Exclude } from 'class-transformer';
import { Comment } from 'src/comments/entities/comment.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { SupplementEquipmentProjectGroup } from 'src/supplement-equipment-project-group/entities/supplement-equipment-project-group.entity';
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

  /**
   * Wave Equipment ผ.03, Phase 2 — DB-02 (2026-05-28).
   * Fourth nullable FK so equipment items can record §12 audit rows
   * the same way PG / RPG / SPG do. Exactly one of the four target
   * FKs is expected to be set per row; downstream code that branches
   * on `if (ts.projectGroupId) … else if (ts.revisedProjectGroupId) …`
   * MUST be extended for equipment (BE-04).
   */
  @ManyToOne(
    () => EquipmentProjectGroup,
    (equipmentProjectGroup) => equipmentProjectGroup.trackingStatus,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'equipment_project_group_id' })
  equipmentProjectGroupId: EquipmentProjectGroup | null;

  /**
   * Wave Equipment Revision Management — DB-01 (Phase 3).
   * Fifth nullable FK so RELPG (RevisedEquipmentProjectGroup) rows can
   * record §12 audit transitions the same way PG / RPG / SPG / EPG do.
   * Exactly one of the six target FKs is expected to be set per row;
   * downstream code that branches on
   * `if (ts.projectGroupId) … else if (ts.revisedProjectGroupId) …
   *  else if (ts.supplementProjectGroupId) …
   *  else if (ts.equipmentProjectGroupId) …
   *  else if (ts.revisedEquipmentProjectGroupId) …`
   * MUST be extended with `… else if (ts.supplementEquipmentProjectGroupId) …`
   * (BE-B1 / BE-B2 own the SEPG service extension).
   */
  @ManyToOne(
    () => RevisedEquipmentProjectGroup,
    (revisedEquipmentProjectGroup) => revisedEquipmentProjectGroup.trackingStatus,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'revised_equipment_project_group_id' })
  revisedEquipmentProjectGroupId: RevisedEquipmentProjectGroup | null;

  /**
   * Wave wave-supplement-equipment-por03 — DB-B2 (2026-06-08).
   * Sixth nullable FK so SEPG (SupplementEquipmentProjectGroup) rows can
   * record §12 audit transitions the same way PG / RPG / SPG / EPG /
   * RELPG do. Exactly one of the six target FKs is expected to be set
   * per row; every downstream FK-chain resolver
   * (`if (ts.projectGroupId) … else if (ts.revisedProjectGroupId) …`)
   * MUST include the `… else if (ts.supplementEquipmentProjectGroupId) …`
   * branch.
   */
  @ManyToOne(
    () => SupplementEquipmentProjectGroup,
    (supplementEquipmentProjectGroup) =>
      supplementEquipmentProjectGroup.trackingStatus,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'supplement_equipment_project_group_id' })
  supplementEquipmentProjectGroupId: SupplementEquipmentProjectGroup | null;

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
