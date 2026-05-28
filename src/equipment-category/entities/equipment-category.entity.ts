import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { EquipmentCategoryScope } from './equipment-category-scope.entity';

/**
 * Wave Equipment ผ.03, Phase 1 — DB-01.
 *
 * Master list of the 14 ครุภัณฑ์ categories that the MOI ผ.03 form
 * recognises. Codes are sparse (1..9, 11..14, 16) — 10 and 15 are
 * intentionally omitted by the MOI form itself.
 *
 * Reference-data only — no per-user scoping, no PII, no workflow
 * binding. The Phase 1 surface enables a single cascading-filter
 * query of the form "given (tacticId, planId), which equipment
 * categories are valid?" via the sibling `EquipmentCategoryScope`
 * junction.
 *
 * Phase 2 (parked — see DB-01 spec §Appendix A) will add an
 * `equipment_project_groups` entity that FK-references this table.
 * This entity is forward-compatible with that future shape.
 *
 * Source of truth:
 *   - docs/tasks/wave-equipment-pro3/DB-01-equipment-entity.md §3, §8.2
 *   - Verification finding F6 — code 16 name is `ครุภัณฑ์อื่น`
 *     (no trailing "ๆ").
 */
@Entity('equipment_categories')
export class EquipmentCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Sparse integer category code (1..9, 11..14, 16). The `code` is
   * the stable lookup key used by ผ.03 and by Phase 2 FKs; the UUID
   * `id` is the row identity.
   */
  @Index('uq_equipment_categories_code', { unique: true })
  @Column({ type: 'int', name: 'code' })
  code: number;

  @Column({ type: 'text', name: 'name' })
  name: string;

  /**
   * Mirrors `code` today. Kept as a separate column so future MOI
   * form re-ordering (if any) does not break the public lookup key.
   */
  @Column({ type: 'int', name: 'sort_order' })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @OneToMany(() => EquipmentCategoryScope, (scope) => scope.equipmentCategory)
  scopes: EquipmentCategoryScope[];
}
