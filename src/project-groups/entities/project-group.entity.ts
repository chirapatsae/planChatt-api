import { Budget } from 'src/budget/entities/budget.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
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
import { Favorite } from 'src/favorite/entities/favorite.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';

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

  @Column('text')
  indicator: string;

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

  @ManyToOne(() => BudgetPlan, (budgetPlan) => budgetPlan.projectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'budget_plan_id' })
  budgetPlan: BudgetPlan;

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
    }, 
  )
  @JoinColumn({ name: 'responsible_agency_id' })
  responsibleAgency: GovernmentAgency;

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
}
