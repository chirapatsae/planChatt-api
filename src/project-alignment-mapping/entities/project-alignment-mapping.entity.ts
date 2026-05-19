/**
 * ProjectAlignmentMapping — Triple-keyed alignment bridge.
 *
 * Maps (strategy, tactic, plan) — the internal LAO project
 * classification — to its corresponding (NS, MS, SDG, PS) — the
 * external strategic alignment.
 *
 * Each row corresponds to ONE Excel row in
 * `ตารางเชื่อมโยง ทำโปรแกรม.xlsx` (after combo / duplicate filtering).
 *
 * §12 — config rows; NO TrackingStatus interaction.
 * §4.1 — write authority = admin / super-admin (BE service gate);
 *        read = any authenticated user.
 */

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  UpdateDateColumn,
  Unique,
  Index,
} from 'typeorm';

import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { NationalStrategy } from 'src/national-strategy/entities/national-strategy.entity';
import { Milestone } from 'src/milestone/entities/milestone.entity';
import { Sdg } from 'src/sdg/entities/sdg.entity';
import { ProvinceStrategy } from 'src/province-strategy/entities/province-strategy.entity';
import { User } from 'src/users/entities/user.entity';

@Entity({ name: 'project_alignment_mapping' })
@Unique('UQ_project_alignment_triple', ['strategyId', 'tacticId', 'planId'])
@Index(['strategyId'])
@Index(['tacticId'])
@Index(['planId'])
export class ProjectAlignmentMapping {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // --- Internal classification triple (VARCHAR PKs) ---

  @Column({ name: 'strategy_id', type: 'varchar' })
  strategyId: string;

  @ManyToOne(() => Strategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'strategy_id' })
  strategy: Strategy;

  @Column({ name: 'tactic_id', type: 'varchar' })
  tacticId: string;

  @ManyToOne(() => Tactic, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tactic_id' })
  tactic: Tactic;

  @Column({ name: 'plan_id', type: 'varchar' })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  // --- External strategic alignment (UUID PKs) ---

  @Column({ name: 'national_strategy_id', type: 'uuid' })
  nationalStrategyId: string;

  @ManyToOne(() => NationalStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'national_strategy_id' })
  nationalStrategy: NationalStrategy;

  @Column({ name: 'milestone_id', type: 'uuid' })
  milestoneId: string;

  @ManyToOne(() => Milestone, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'milestone_id' })
  milestone: Milestone;

  @Column({ name: 'sdg_id', type: 'uuid' })
  sdgId: string;

  @ManyToOne(() => Sdg, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sdg_id' })
  sdg: Sdg;

  @Column({ name: 'province_strategy_id', type: 'uuid' })
  provinceStrategyId: string;

  @ManyToOne(() => ProvinceStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'province_strategy_id' })
  provinceStrategy: ProvinceStrategy;

  // --- Audit ---

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedBy: User | null;
}
