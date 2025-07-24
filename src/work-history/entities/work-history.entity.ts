import { ProjectGroup } from './../../project-groups/entities/project-group.entity';
import { Amphoe } from "src/amphoes/entities/amphoe.entity";
import { User } from "src/users/entities/user.entity";
import { CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { Role } from 'src/roles/entities/role.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { Status } from 'src/status/entities/status.entity';

@Entity({ name: "work_history" })
export class WorkHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Amphoe, (amphoe) => amphoe.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'amphoe_id' })
  amphoe: Amphoe;

  @ManyToOne(() => LocalAdministrativeOrganization, (localAdministrativeOrganization) => localAdministrativeOrganization.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'local_admistrative_organization_org_id' })
  localAdministrativeOrganization: LocalAdministrativeOrganization;

  @ManyToOne(() => User, (user) => user.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => WorkStatus, (workStatus) => workStatus.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'work_status_id' })
  workStatus: WorkStatus

  @ManyToOne(() => Role, (role) => role.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'role_id' })
  role: Role

  @ManyToOne(() => GovernmentAgency, (govermentAgency) => govermentAgency.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'government_agencies_id' })
  governmentAgencies?: GovernmentAgency

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => User, (user) => user.createdWorkHistory, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  })
  @JoinColumn({ name: 'created_by' })
  createdBy?: User;
  
  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => User, (user) => user.updatedWorkHistory, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  })
  @JoinColumn({ name: 'updated_by' })
  updatedBy?: User;

  @OneToMany(() => WorkHistoryAmphoeResponsibility, (workHistoryResponsibleAdmins) => workHistoryResponsibleAdmins.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  workHistoryResponsibleAdmins: WorkHistoryAmphoeResponsibility[];

  @OneToMany(() => BudgetPlan, (budgetPlan) => budgetPlan.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  budgetPlan : BudgetPlan[];

  @OneToMany(() => Strategy, (strategy) => strategy.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  creatorStrategy : Strategy[];

  @OneToMany(() => Strategy, (strategy) => strategy.deletedBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  deletorStrategy : Strategy[];

  @OneToMany(() => ProjectGroup, (projectGroup) => projectGroup.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  creatorProjectGroup : ProjectGroup[];

  @OneToMany(() => ProjectGroup, (projectGroup) => projectGroup.responsibleBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  responsibleProjectGroup : ProjectGroup[];

  @OneToMany(() => Tactic, (tactic) => tactic.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  creatorTactic : Tactic[];

  @OneToMany(() => Tactic, (tactic) => tactic.deletedBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  deletorTactic : Tactic[];

  @OneToMany(() => Plan, (plan) => plan.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  creatorPlan : Plan[];

  @OneToMany(() => Plan, (plan) => plan.deletedBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  deletorPlan : Plan[];

  @OneToMany(() => TrackingStatus, (trackingStatus) => trackingStatus.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  creatorTrackingStatus : TrackingStatus[];

  @OneToMany(() => TrackingStatus, (trackingStatus) => trackingStatus.deletedBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  deletorTrackingStatus : TrackingStatus[];

  @OneToMany(() => Status, (status) => status.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  creatorStatus : Status[];

  @OneToMany(() => Status, (status) => status.deletedBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  deletorStatus : Status[];

}




