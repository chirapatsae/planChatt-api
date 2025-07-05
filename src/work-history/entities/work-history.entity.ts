import { ProjectGroup } from './../../project-groups/entities/project-group.entity';
import { Amphoe } from "src/amphoes/entities/amphoe.entity";
import { ProjectType } from 'src/project-types/entities/project-type.entity';
import { User } from "src/users/entities/user.entity";
import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { WorkHistoryAmphoeResponsibility } from './work-history-amphoe-responsibility.entity';

@Entity({ name: "work_history" })
export class WorkHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
  createAt: Date;

  @Column({ name: 'division_name', nullable: true })
  divisionName?: string

  @Column({ name: 'division_id', nullable: true })
  divisionId?: string

  @ManyToOne(() => User, (user) => user.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'user' })
  user: User;

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
  @JoinColumn({ name: 'local_admistrative_organization_id' })
  localAdministrativeOrganization: LocalAdministrativeOrganization;

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

  // สำหรับ admin role - อำเภอที่รับผิดชอบ (ผ่าน junction entity)
  @OneToMany(() => WorkHistoryAmphoeResponsibility, (responsibility) => responsibility.workHistory, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  responsibilities: WorkHistoryAmphoeResponsibility[];

  @Column({ default: 'user' })
  role: 'user' | 'admin' | 'superadmin';

  @Column({ default: 'unverify' })
  status: 'unverify' | 'approved' | 'suspended' | 'banned';


 // --- ส่วนที่แก้ไข ---

 @Column({ name: 'approve_at', type: 'timestamp', nullable: true }) // 1. ควรเป็น nullable เพราะตอนแรกยังไม่มีการ approve
 approveAt: Date;

 // 2. สร้างความสัมพันธ์ Many-to-One ไปยัง WorkHistory (ตัวเอง)
 @ManyToOne(() => WorkHistory, (approver) => approver.approvedHistories, {
   nullable: true, // ผู้อนุมัติอาจเป็นค่าว่างได้ (ตอนยังไม่ approve)
   onDelete: 'SET NULL' // ถ้าผู้อนุมัติถูกลบ ให้เซ็ต field นี้เป็น NULL
 })
 @JoinColumn({ name: 'approved_by_id' }) // 3. สร้าง Foreign Key ในตาราง
 approvedBy: WorkHistory;

 // 4. (Optional but recommended) สร้างความสัมพันธ์ด้านกลับ
 @OneToMany(() => WorkHistory, (approvedRecord) => approvedRecord.approvedBy)
 approvedHistories: WorkHistory[]; // รายการทั้งหมดที่ user คนนี้เคย approve
}
