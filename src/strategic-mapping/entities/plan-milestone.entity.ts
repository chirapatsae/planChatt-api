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
import { Milestone } from 'src/milestone/entities/milestone.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * PlanMilestone — Strategic Graph plan-mapping junction
 * (Plan ↔ Milestone).
 *
 * Mirrors the DB-03 table `plan_milestone`. `plan_id` is varchar(255).
 * Plan side uses ON DELETE CASCADE; master side uses ON DELETE
 * RESTRICT. Config metadata — NO §12 TrackingStatus interaction.
 */
@Entity('plan_milestone')
@Unique('UQ_plan_milestone_pair', ['planId', 'milestoneId'])
@Index(['planId'])
@Index(['milestoneId'])
export class PlanMilestone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'plan_id', type: 'varchar', length: 255 })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

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
