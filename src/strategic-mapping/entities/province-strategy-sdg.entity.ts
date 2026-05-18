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
import { Sdg } from 'src/sdg/entities/sdg.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * ProvinceStrategySdg — Strategic Graph inter-master junction
 * (Province Strategy ↔ SDG).
 *
 * Mirrors the DB-02 table `province_strategy_sdg`. Both FKs use
 * ON DELETE RESTRICT. Config metadata — NO §12 TrackingStatus
 * interaction.
 */
@Entity('province_strategy_sdg')
@Unique('UQ_province_strategy_sdg_pair', ['provinceStrategyId', 'sdgId'])
@Index(['provinceStrategyId'])
@Index(['sdgId'])
export class ProvinceStrategySdg {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'province_strategy_id', type: 'uuid' })
  provinceStrategyId: string;

  @ManyToOne(() => ProvinceStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'province_strategy_id' })
  provinceStrategy: ProvinceStrategy;

  @Column({ name: 'sdg_id', type: 'uuid' })
  sdgId: string;

  @ManyToOne(() => Sdg, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sdg_id' })
  sdg: Sdg;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedBy: User | null;
}
