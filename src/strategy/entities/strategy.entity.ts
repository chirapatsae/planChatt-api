import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Entity, Column, PrimaryColumn, OneToMany, CreateDateColumn, DeleteDateColumn, ManyToOne, JoinColumn } from 'typeorm';

@Entity('strategies')
export class Strategy {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @OneToMany(() => Tactic , (tactic)=> tactic.strategy , {
    onDelete : 'CASCADE' ,
    onUpdate : 'CASCADE'
  })
  tactic : Tactic[]

  @OneToMany(() => ProjectGroup , (projectGroup)=> projectGroup.strategy , {
    onDelete : 'CASCADE' ,
    onUpdate : 'CASCADE'
  })
  projectGroup : ProjectGroup[]

  @CreateDateColumn({name : 'created_at'})
  createdAt : Date

  @ManyToOne(() => WorkHistory , (workHistory) => workHistory.creatorStrategy , {
    onUpdate : 'CASCADE',
    onDelete : 'CASCADE'
  })
  @JoinColumn({name : 'created_by'})
  createdBy : WorkHistory

  @DeleteDateColumn({name : 'deleted_at' , nullable : true})
  deletedAt : Date

  @ManyToOne(() => WorkHistory , (workHistory) => workHistory.deletorStrategy , {
    onUpdate : 'CASCADE',
    onDelete : 'CASCADE'
  })
  @JoinColumn({name : 'deleted_by'})
  deletedBy : WorkHistory
}
