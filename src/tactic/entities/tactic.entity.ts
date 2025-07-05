import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { PlanTactic } from 'src/plan/entities/plan-tactic.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Entity('tactics')
export class Tactic {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @ManyToOne(() => Strategy, (strategy) => strategy.tactic, { eager: true })
  @JoinColumn({ name: 'strategy_id' })
  strategy: Strategy;

  @OneToMany(() => ProjectGroup, (projectGroup) => projectGroup.tactic, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  })
  projectGroup: ProjectGroup[]

  @OneToMany(() => PlanTactic, pt => pt.tactic)
  planTactics: PlanTactic[];

}

