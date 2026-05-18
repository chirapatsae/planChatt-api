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
import { NationalStrategy } from 'src/national-strategy/entities/national-strategy.entity';
import { Milestone } from 'src/milestone/entities/milestone.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * NationalStrategyMilestone — Strategic Graph inter-master junction
 * (National Strategy ↔ Milestone).
 *
 * Mirrors the table `national_strategy_milestone` created by
 * `1779150000000-AddStrategicGraphChainJunctions.ts`. Both master FKs use
 * ON DELETE RESTRICT (the master row cannot vanish out from under a live
 * mapping). `updated_by` is a soft-tracking audit column (ON DELETE
 * SET NULL) and pairs with `updated_at` for replace-mode audit per the
 * STRATEGIC_GRAPH_CHAIN umbrella locked decisions.
 *
 * This is config metadata — NO §12 TrackingStatus interaction.
 */
@Entity('national_strategy_milestone')
@Unique('UQ_national_strategy_milestone_pair', [
  'nationalStrategyId',
  'milestoneId',
])
@Index(['nationalStrategyId'])
@Index(['milestoneId'])
export class NationalStrategyMilestone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedBy: User | null;
}
