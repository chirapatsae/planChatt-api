import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('government_agencies')
export class GovernmentAgency {
  @PrimaryGeneratedColumn()
  id: string;

  @Column()
  name: string;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(
    () => WorkHistory,
    (workHistory) => workHistory.governmentAgencies,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  workHistory: WorkHistory[];

  @OneToMany(
    () => ProjectGroup,
    (projectGroup) => projectGroup.responsibleAgency,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  responsibleAgencyProjectGroup: ProjectGroup[];

  projectCount?: number;
}
