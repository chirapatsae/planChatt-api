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
import { Sdg } from 'src/sdg/entities/sdg.entity';
import { NationalStrategy } from 'src/national-strategy/entities/national-strategy.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * SdgNationalStrategy — Strategic Graph inter-master junction (SDG ↔ National Strategy).
 *
 * Mirrors the DB-02 table `sdg_national_strategy` created by
 * `1779130000000-StrategicGraphJunctions.ts`. Both FKs use ON DELETE
 * RESTRICT (the master row cannot vanish out from under a live mapping).
 * `updated_by` is a soft-tracking audit column (ON DELETE SET NULL) and
 * pairs with `updated_at` for replace-mode audit per the umbrella locked
 * decisions.
 *
 * This is config metadata — NO §12 TrackingStatus interaction.
 */
@Entity('sdg_national_strategy')
@Unique('UQ_sdg_national_strategy_pair', ['sdgId', 'nationalStrategyId'])
@Index(['sdgId'])
@Index(['nationalStrategyId'])
export class SdgNationalStrategy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'sdg_id', type: 'uuid' })
  sdgId: string;

  @ManyToOne(() => Sdg, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sdg_id' })
  sdg: Sdg;

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
