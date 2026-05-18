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
import { ProvinceStrategy } from 'src/province-strategy/entities/province-strategy.entity';
import { NationalStrategy } from 'src/national-strategy/entities/national-strategy.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * ProvinceStrategyNationalStrategy — Strategic Graph inter-master
 * junction (Province Strategy ↔ National Strategy).
 *
 * Mirrors the DB-02 table `province_strategy_national_strategy`. Both
 * FKs use ON DELETE RESTRICT. Config metadata — NO §12 TrackingStatus
 * interaction.
 */
@Entity('province_strategy_national_strategy')
@Unique('UQ_province_strategy_national_strategy_pair', [
  'provinceStrategyId',
  'nationalStrategyId',
])
@Index(['provinceStrategyId'])
@Index(['nationalStrategyId'])
export class ProvinceStrategyNationalStrategy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'province_strategy_id', type: 'uuid' })
  provinceStrategyId: string;

  @ManyToOne(() => ProvinceStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'province_strategy_id' })
  provinceStrategy: ProvinceStrategy;

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
