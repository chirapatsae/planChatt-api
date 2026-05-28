/**
 * Wave Equipment ผ.03, Phase 1 — BE-01.
 *
 * Read-only DTO returned by the equipment-category lookup + admin
 * endpoints. Mirrors the entity 1:1 (id, code, name, sortOrder,
 * createdAt, updatedAt, deletedAt).
 */
export class EquipmentCategoryDto {
  id: string;
  code: number;
  name: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Read-only DTO for `equipment_category_scopes` junction rows.
 * tacticId / planId are string natural keys (e.g. `TACT004`, `PLAN003`),
 * NOT UUIDs — see entity-level comments on `EquipmentCategoryScope`.
 */
export class EquipmentCategoryScopeDto {
  id: string;
  equipmentCategoryId: string;
  tacticId: string;
  planId: string;
}
