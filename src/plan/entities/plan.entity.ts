import { Entity, PrimaryColumn, Column, OneToMany } from 'typeorm';
import { PlanTactic } from './plan-tactic.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Entity('plans')
export class Plan {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @OneToMany(() => PlanTactic, planTactic => planTactic.plan, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  planTactics: PlanTactic[];

  @OneToMany(() => ProjectGroup , (projectGroup) => projectGroup.plan , {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  projectGroup: ProjectGroup[];
}
