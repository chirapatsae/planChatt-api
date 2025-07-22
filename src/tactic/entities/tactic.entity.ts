import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn, OneToMany, CreateDateColumn, DeleteDateColumn } from 'typeorm';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { PlanTactic } from 'src/plan/entities/plan-tactic.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Entity('tactics')
export class Tactic {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @CreateDateColumn({name : 'created_at'})
  createdAt : Date

  @ManyToOne(() => WorkHistory , (workHistory) => workHistory.creatorTactic , {
    onUpdate : 'CASCADE',
    onDelete : 'CASCADE'
  })
  @JoinColumn({name : 'created_by'})
  createdBy : WorkHistory

  @DeleteDateColumn({name : 'deleted_at' , nullable : true})
  deletedAt : Date

  @ManyToOne(() => WorkHistory , (workHistory) => workHistory.deletorTactic , {
    onUpdate : 'CASCADE',
    onDelete : 'CASCADE'
  })
  @JoinColumn({name : 'deleted_by'})
  deletedBy : WorkHistory

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

