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
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';

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

  /**
   * Wave Equipment ผ.03, Phase 2 — DB-02 (2026-05-28).
   * Fourth nullable FK extending the polymorphic budget pattern to
   * equipment items. Exactly one of `projectGroupId` /
   * `revisedProjectGroupId` / `supplementProjectGroupId` /
   * `equipmentProjectGroupId` is expected to be set per row (not
   * DB-enforced — same convention as the existing three FKs).
   */
  @IsOptional()
  @ManyToOne(() => EquipmentProjectGroup, (equipmentProjectGroup) => equipmentProjectGroup.budgets, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'equipment_project_group_id' })
  equipmentProjectGroupId?: EquipmentProjectGroup;

  /**
   * Wave Equipment Revision Management — DB-01 (Phase 3).
   * Fifth nullable FK extending the polymorphic budget pattern to RELPG
   * (RevisedEquipmentProjectGroup) rows. Exactly one of `projectGroupId` /
   * `revisedProjectGroupId` / `supplementProjectGroupId` /
   * `equipmentProjectGroupId` / `revisedEquipmentProjectGroupId` is
   * expected to be set per row (not DB-enforced — same convention as the
   * existing four FKs).
   */
  @IsOptional()
  @ManyToOne(
    () => RevisedEquipmentProjectGroup,
    (revisedEquipmentProjectGroup) => revisedEquipmentProjectGroup.budgets,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'revised_equipment_project_group_id' })
  revisedEquipmentProjectGroupId?: RevisedEquipmentProjectGroup;

  @Column()
  year: number;

  @Column('decimal', { precision: 18, scale: 2 })
  quantity: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
