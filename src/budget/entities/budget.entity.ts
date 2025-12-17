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
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';

@Entity('budget')
export class Budget {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => ProjectGroup, (projectGroup) => projectGroup.budgets, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'project_group_id' })
  projectGroupId?: ProjectGroup;

  @IsOptional()
  @ManyToOne(() => RevisedProjectGroup, (revisedProjectGroup) => revisedProjectGroup.budgets, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'revised_project_group_id' })
  revisedProjectGroupId?: RevisedProjectGroup;

  @IsOptional()
  @ManyToOne(() => SupplementProjectGroup, (supplementProjectGroup) => supplementProjectGroup.budgets, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'supplement_project_group_id' })
  supplementProjectGroupId?: SupplementProjectGroup;

  @Column()
  year: number;

  @Column('decimal', { precision: 18, scale: 2 })
  quantity: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
