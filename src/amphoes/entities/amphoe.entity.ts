import { Exclude } from 'class-transformer';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import {
  Column,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';

@Entity('amphoes')
export class Amphoe {
  @PrimaryColumn()
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
  createAt: Date;

  @DeleteDateColumn({ nullable: true })
  @Exclude() // 👈 ซ่อน
  deletedAt?: Date;

  @OneToMany(() => WorkHistory, (workHistory) => workHistory.amphoe, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  workHistory: WorkHistory[];

  @OneToMany(
    () => LocalAdministrativeOrganization,
    (localAdministrativeOrganization) => localAdministrativeOrganization.amphoe,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  localAdministrativeOrganization: LocalAdministrativeOrganization[];

  // สำหรับ admin role - workHistory ที่รับผิดชอบอำเภอนี้
  @OneToMany(
    () => WorkHistoryAmphoeResponsibility,
    (responsibility) => responsibility.amphoe,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  workHistoryResponsibleAmphoe: WorkHistoryAmphoeResponsibility[];

  @OneToMany(
    () => ProjectGroup,
    (projectGroup) => projectGroup.amphoe,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  projectGroups: ProjectGroup[];
}
