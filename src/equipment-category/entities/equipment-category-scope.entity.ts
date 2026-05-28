import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { EquipmentCategory } from './equipment-category.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';

/**
 * Wave Equipment ผ.03, Phase 1 — DB-01.
 *
 * Junction encoding which `(equipment_category, tactic, plan)`
 * triples are valid per the user-submitted ผ.03 dataset (42 rows;
 * note: the original CTO spec said "41" but the user-corrected count
 * is 42 — DB-01 task message §"Two corrections").
 *
 * No soft-delete: junction rows are recreated, not soft-removed.
 *
 * Composite UNIQUE on (equipment_category_id, tactic_id, plan_id) is
 * both the idempotency key for re-running the seed migration and the
 * dedup guard against future operator drift.
 *
 * The F7 EXISTS guard in the seed migration ensures every
 * (tactic_id, plan_id) pair already exists in `plan_tactics` — so
 * this junction never references a (tactic, plan) link the rest of
 * the system does not know about.
 *
 * Source of truth:
 *   - docs/tasks/wave-equipment-pro3/DB-01-equipment-entity.md §3, §8.3, §8.4
 *   - Verification finding F7 — pre-insert EXISTS guard against plan_tactics
 */
@Entity('equipment_category_scopes')
@Unique('uq_equipment_category_scope_triple', [
  'equipmentCategoryId',
  'tacticId',
  'planId',
])
@Index('idx_equipment_category_scope_tactic_plan', ['tacticId', 'planId'])
@Index('idx_equipment_category_scope_plan', ['planId'])
export class EquipmentCategoryScope {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'equipment_category_id' })
  equipmentCategoryId: string;

  /**
   * tactics.id is a string PK (natural key like 'TACT004'); we mirror
   * its type here verbatim. No `code` column exists on `tactics` —
   * the id IS the code (DB-01 task message correction).
   */
  @Column({ type: 'varchar', name: 'tactic_id' })
  tacticId: string;

  /** plans.id — string PK (natural key like 'PLAN003'); see tacticId. */
  @Column({ type: 'varchar', name: 'plan_id' })
  planId: string;

  @ManyToOne(() => EquipmentCategory, (cat) => cat.scopes, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'equipment_category_id' })
  equipmentCategory: EquipmentCategory;

  @ManyToOne(() => Tactic, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'tactic_id' })
  tactic: Tactic;

  @ManyToOne(() => Plan, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
