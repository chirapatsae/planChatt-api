import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Entity, Column, PrimaryColumn, OneToMany } from 'typeorm';

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
}
