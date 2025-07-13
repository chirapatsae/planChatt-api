import { ProjectGroup } from './../../project-groups/entities/project-group.entity';
import { Amphoe } from "src/amphoes/entities/amphoe.entity";
import { User } from "src/users/entities/user.entity";
import {  CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { Role } from 'src/roles/entities/role.entity';
import { Position } from 'src/positions/entities/position.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';

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
  governmentAgencies? : GovernmentAgency



  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.creator, {
    onUpdate : 'CASCADE',
    onDelete : 'CASCADE'
  })
  @JoinColumn({ name: 'created_by' })
  createdBy?: WorkHistory;
  
  @OneToMany(() => WorkHistory, (workHistory) => workHistory.createdBy)
  creator: WorkHistory[];
  

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;


  @OneToMany(() => ProjectGroup, (projectGroup) => projectGroup.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  projectGroup: ProjectGroup[];

  @OneToMany(() => TrackingStatus, (trackingStatus) => trackingStatus.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  trackingStatus: TrackingStatus[];

  @OneToMany(() => WorkHistoryAmphoeResponsibility, (workHistoryResponsibleAdmins) => workHistoryResponsibleAdmins.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  workHistoryResponsibleAdmins : WorkHistoryAmphoeResponsibility[];

  @OneToMany(() => Position, (position) => position.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  position?: Position




}




