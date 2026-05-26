import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';

@Entity('development_plan_supplement')
export class DevelopmentPlanSupplement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => DevelopmentPlan, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;

  @Column({ name: 'supplement_number', type: 'int' })
  supplementNumber: number;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ name: 'is_latest', default: false })
  isLatest: boolean;

  @Column({ name: 'is_booked', default: false })
  isBooked: boolean;

  @Column({ name: 'is_open', default: false })
  isOpen: boolean;

  @Column({ name: 'start_date', type: 'timestamp', nullable: true })
  startDate: Date | null;

  @Column({ name: 'end_date', type: 'timestamp', nullable: true })
  endDate: Date | null;

  /**
   * CLAUDE.md §15.2 / §15.3 Book Lineage Immutability — finalize-moment
   * timestamp used by the cross-category linear-chain ordering
   * (wave-lineage-linear-chain-by-bookedAt). NULL while the supplement
   * is a draft (`isBooked = false`); set at the moment `isBooked` flips
   * to `true` (BE-01 wires the write). Backfilled per DB-01 migration
   * from `supplement_assembly_versions.merged_at` joined on
   * `development_plan_supplement_id` (fallback `created_at`).
   */
  @Column({ name: 'booked_at', type: 'timestamptz', nullable: true })
  bookedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(() => WorkHistory, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;

  @OneToMany(() => SupplementProjectGroup, (supplementProjectGroup) => supplementProjectGroup.developmentPlanSupplement, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  supplementProjectGroups: SupplementProjectGroup[];

  /**
   * CLAUDE.md §15 Book Lineage Immutability.
   *
   * Runtime-only flag populated by
   * `DevelopmentPlanService.decorateBookLockFlags`. NOT a database column.
   *
   * Declared as a plain class field so that:
   *   1. `class-transformer` (`ClassSerializerInterceptor` in main.ts)
   *      reliably preserves the property during JSON serialization of
   *      the response body — dynamic `(obj as any).x = …` assignments
   *      are brittle under strict / grouped transform configurations.
   *   2. TypeScript understands the field exists on the entity and
   *      downstream callers no longer need `as any` casts.
   *
   * `true` when ANY other non-soft-deleted revision or supplement of the
   * same `DevelopmentPlan` has a strictly-newer `createdAt` — OQ-2=(B)
   * global timeline across BOTH collections.
   */
  hasNewerRevision?: boolean;
}

