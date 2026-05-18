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
import { Milestone } from 'src/milestone/entities/milestone.entity';
import { Sdg } from 'src/sdg/entities/sdg.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * MilestoneSdg — Strategic Graph inter-master junction (Milestone ↔ SDG).
 *
 * Mirrors the DB-02 table `milestone_sdg`. Both FKs use ON DELETE
 * RESTRICT. Config metadata — NO §12 TrackingStatus interaction.
 */
@Entity('milestone_sdg')
@Unique('UQ_milestone_sdg_pair', ['milestoneId', 'sdgId'])
@Index(['milestoneId'])
@Index(['sdgId'])
export class MilestoneSdg {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedBy: User | null;
}
