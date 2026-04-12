import { Budget } from 'src/budget/entities/budget.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AttachmentProjectGroup } from 'src/attachment-project-groups/entities/attachment-project-group.entity';
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
import { Favorite } from 'src/favorite/entities/favorite.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';

@Entity('project_groups')
export class ProjectGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  /**
   * CLAUDE.md §16.5 — nullable for ISSUE_BASED plans.
   * A DB CHECK constraint enforces exactly-one-shape together with
   * strategy_id / tactic_id / plan_id / development_issue_id.
   */
  @Column('text', { nullable: true })
  indicator: string | null;

  @Column('text')
  expected: string;

  @Column()
  projectYear: number;

  @Column({ default: false })
  isDraft: boolean;

  @Column({ default: false })
  isBooked: boolean;

  @Column({ type: 'timestamp', nullable: true })
  bookedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  pageNumber: number | null;

  @ManyToOne(() => Strategy, (strategy) => strategy.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'strategy_id' })
  strategy: Strategy | null;

  @ManyToOne(() => Tactic, (tactic) => tactic.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'tactic_id' })
  tactic: Tactic | null;

  @ManyToOne(() => Plan, (plan) => plan.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan | null;

  /**
   * CLAUDE.md §16 Multi-Format Reporting — ISSUE_BASED classification.
   * Mutually exclusive with (strategy, tactic, plan, indicator) per the
   * §16.5 shape invariant and the `chk_project_groups_classification_shape`
   * DB CHECK constraint.
   */
  @ManyToOne(() => DevelopmentIssue, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'development_issue_id' })
  developmentIssue: DevelopmentIssue | null;

  @ManyToOne(() => DevelopmentPlan, (developmentPlan) => developmentPlan.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;

  @ManyToOne(
    () => WorkHistory,
    (workHistory) => workHistory.creatorProjectGroup,
    {
      onDelete: 'CASCADE',
    }
  )
  @JoinColumn({ name: 'create_by' })
  createdBy?: WorkHistory;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(
    () => Amphoe,
    (amphoe) => amphoe.projectGroups,
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
    (lao) => lao.projectGroups,
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

  @OneToMany(() => Budget, (budget) => budget.projectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  budgets: Budget[];

  @OneToMany(() => TrackingStatus, (budget) => budget.projectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  trackingStatus: TrackingStatus[];

  @OneToMany(() => Favorite, (favorite) => favorite.projectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  favorites: Favorite[];

  @OneToMany(() => RevisedProjectGroup, (revised) => revised.projectGroup, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  revisedProjectGroups: RevisedProjectGroup[];

  @OneToMany(
    () => AttachmentProjectGroup,
    (attachment) => attachment.projectGroup, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  }
  )
  attachments: AttachmentProjectGroup[];
}
