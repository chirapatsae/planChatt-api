import { Entity, PrimaryColumn, Column, OneToMany, JoinColumn } from 'typeorm';
import { PlanTactic } from './plan-tactic.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Entity('plans')
export class Plan {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @OneToMany(() => PlanTactic, planTactic => planTactic.plan)
  planTactics: PlanTactic[];

  @OneToMany(() => ProjectGroup , (projectGroup) => projectGroup.plan , {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  projectGroup: ProjectGroup[];
}
