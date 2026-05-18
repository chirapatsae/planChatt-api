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
import { Sdg } from 'src/sdg/entities/sdg.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * PlanSdg — Strategic Graph plan-mapping junction (Plan ↔ SDG).
 *
 * Mirrors the DB-03 table `plan_sdg`. `plan_id` is varchar(255) to
 * mirror `plans.id` exactly (FK type-match). Plan side uses ON DELETE
 * CASCADE; master side uses ON DELETE RESTRICT. Config metadata — NO
 * §12 TrackingStatus interaction.
 */
@Entity('plan_sdg')
@Unique('UQ_plan_sdg_pair', ['planId', 'sdgId'])
@Index(['planId'])
@Index(['sdgId'])
export class PlanSdg {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'plan_id', type: 'varchar', length: 255 })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

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
