import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Plan } from 'src/plan/entities/plan.entity';
import { ProvinceStrategy } from 'src/province-strategy/entities/province-strategy.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * PlanProvinceStrategy — Strategic Graph plan-mapping junction
 * (Plan ↔ Province Strategy).
 *
 * Mirrors the DB-03 table `plan_province_strategy`. `plan_id` is
 * varchar(255). Plan side uses ON DELETE CASCADE; master side uses
 * ON DELETE RESTRICT. Config metadata — NO §12 TrackingStatus
 * interaction.
 */
@Entity('plan_province_strategy')
@Unique('UQ_plan_province_strategy_pair', ['planId', 'provinceStrategyId'])
@Index(['planId'])
@Index(['provinceStrategyId'])
export class PlanProvinceStrategy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'plan_id', type: 'varchar', length: 255 })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @Column({ name: 'province_strategy_id', type: 'uuid' })
  provinceStrategyId: string;

  @ManyToOne(() => ProvinceStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'province_strategy_id' })
  provinceStrategy: ProvinceStrategy;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedBy: User | null;
}
