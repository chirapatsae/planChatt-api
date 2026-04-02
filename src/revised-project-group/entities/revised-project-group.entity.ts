import { Budget } from 'src/budget/entities/budget.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  JoinColumn,
  DeleteDateColumn,
  OneToMany,
} from 'typeorm';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { PrevProjectType } from '../dto/create-revised-project-group.dto';
import { AttachmentRevisedProjectGroup } from 'src/attachment-revised-project-groups/entities/attachment-revised-project-group.entity';
import { Favorite } from 'src/favorite/entities/favorite.entity';

@Entity('revised_project_groups')
export class RevisedProjectGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => DevelopmentPlanRevision, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'development_plan_revision_id' })
  developmentPlanRevision: DevelopmentPlanRevision;

  @ManyToOne(() => DevelopmentPlan, (developmentPlan) => developmentPlan.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan?: DevelopmentPlan;

  @ManyToOne(() => ProjectGroup, (projectGroup) => projectGroup.revisedProjectGroups, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'project_group_id' })
  projectGroup: ProjectGroup | null;

  @Column()
  title: string;

  @Column('text')
  objective: string;

  @Column('text')
  goal: string;

  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  startLat: number | null;
  
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  startLng: number | null;
  
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  endLat: number | null;
  
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  endLng: number | null;

  @Column('text')
  indicator: string;

  @Column('text')
  expected: string;

  @Column()
  projectYear: number;

  @Column({ default: false })
  isBooked: boolean;

  @Column({ type: 'timestamp', nullable: true })
  bookedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  pageNumber: number | null;

  @ManyToOne(() => Strategy, (strategy) => strategy.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'strategy_id' })
  strategy: Strategy;

  @ManyToOne(() => Tactic, (tactic) => tactic.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'tactic_id' })
  tactic: Tactic;

  @ManyToOne(() => Plan, (plan) => plan.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @ManyToOne(
    () => WorkHistory,
    (workHistory) => workHistory.creatorProjectGroup,
  )
  @JoinColumn({ name: 'create_by' })
  createdBy?: WorkHistory;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(
    () => Amphoe,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'amphoe_id' })
  amphoe?: Amphoe;

  @ManyToOne(
    () => LocalAdministrativeOrganization,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'local_administrative_organization_id' })
  localAdministrativeOrganization?: LocalAdministrativeOrganization;

  @ManyToOne(
    () => LocalAdministrativeOrganization,
    (lao) => lao.originAgencyProjectGroup,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'origin_agency_id' })
  originAgencyId: LocalAdministrativeOrganization;

  @ManyToOne(
    () => GovernmentAgency,
    (governmentAgency) => governmentAgency.responsibleAgencyProjectGroup,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      nullable: true,
    }, 
  )
  @JoinColumn({ name: 'responsible_agency_id' })
  responsibleAgency: GovernmentAgency | null;

  @OneToMany(() => Budget, (budget) => budget.revisedProjectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  budgets: Budget[];

  @OneToMany(() => TrackingStatus, (trackingStatus) => trackingStatus.revisedProjectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  trackingStatus: TrackingStatus[];

  // Free-form additional detail field for extra description
  @Column('text', { nullable: true })
  additionalDetail: string | null;

  @Column('text', { nullable: true })
  oldAdditionDetail: string | null;

  @Column({ name: 'prev_project_id', nullable: true })
  prevProjectId: string;

  @Column({
    name: 'prev_project_type',
    type: 'enum',
    enum: PrevProjectType,
    nullable: true,
  })
  prevProjectType: PrevProjectType;

  @OneToMany(
    () => AttachmentRevisedProjectGroup,
    (attachment) => attachment.revisedProjectGroup,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
  )
  attachments: AttachmentRevisedProjectGroup[];

  @OneToMany(() => Favorite, (favorite) => favorite.revisionProjectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  favorites: Favorite[];
}
