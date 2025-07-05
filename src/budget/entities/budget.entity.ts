// budget.entity.ts
import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    CreateDateColumn,
    JoinColumn,
  } from 'typeorm';
  import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { IsOptional } from 'class-validator';
  
  @Entity('budget')
  export class Budget {
    @PrimaryGeneratedColumn('uuid')
    id: string;
  
    @ManyToOne(() => ProjectGroup, (projectGroup) => projectGroup.budgets ,{
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'project_group_id' })
    projectGroup?: ProjectGroup;

    @IsOptional()
    @Column({name : 'project_version_id' , nullable : true})
    projectVersionId? : number
  
    @Column()
    year: number;
   
    @Column('decimal', { precision: 18, scale: 2 })
    quantity: number;
  
    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
  }