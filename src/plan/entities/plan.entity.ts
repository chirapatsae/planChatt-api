import {
  Entity,
  PrimaryColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  DeleteDateColumn,
} from 'typeorm';
import { PlanTactic } from './plan-tactic.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Entity('plans')
export class Plan {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.creatorPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt: Date;

  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.deletorPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'deleted_by' })
  deletedBy: WorkHistory;

  @OneToMany(() => PlanTactic, (planTactic) => planTactic.plan, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  planTactics: PlanTactic[];

  @OneToMany(() => ProjectGroup, (projectGroup) => projectGroup.plan, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  projectGroup: ProjectGroup[];
}
