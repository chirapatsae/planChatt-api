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
import { NationalStrategy } from 'src/national-strategy/entities/national-strategy.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * PlanNationalStrategy — Strategic Graph plan-mapping junction
 * (Plan ↔ National Strategy).
 *
 * Mirrors the DB-03 table `plan_national_strategy`. `plan_id` is
 * varchar(255). Plan side uses ON DELETE CASCADE; master side uses
 * ON DELETE RESTRICT. Config metadata — NO §12 TrackingStatus
 * interaction.
 */
@Entity('plan_national_strategy')
@Unique('UQ_plan_national_strategy_pair', ['planId', 'nationalStrategyId'])
@Index(['planId'])
@Index(['nationalStrategyId'])
export class PlanNationalStrategy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'plan_id', type: 'varchar', length: 255 })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @Column({ name: 'national_strategy_id', type: 'uuid' })
  nationalStrategyId: string;

  @ManyToOne(() => NationalStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'national_strategy_id' })
  nationalStrategy: NationalStrategy;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedBy: User | null;
}
