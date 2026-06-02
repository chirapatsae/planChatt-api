/**
 * Wave Equipment Revision Management — DB-01 (Phase 3).
 *
 * Lineage discriminator for the `(prev_project_id, prev_project_type)`
 * pair on `revised_equipment_project_groups`. This is the equipment
 * (ผ.03) analog of the `PrevProjectType` enum used by RPG.
 *
 * Per the DB-01 task spec §7.2 decision, this is a SEPARATE enum (NOT an
 * extension of the RPG `PrevProjectType`) and the backing
 * `prev_project_type` column is a plain `varchar` — NOT a shared
 * Postgres enum. Rationale:
 *
 * - Avoids cross-module coupling with the RPG DTO file.
 * - Avoids a shared Postgres enum DDL migration dependency on the RPG
 *   enum (`prev_project_type_enum`), which would have to be widened via
 *   `ALTER TYPE ... ADD VALUE` and could not be rolled back cleanly.
 *
 * - `EQUIPMENT`         → parent is an `EquipmentProjectGroup` (the
 *                         first-generation fork from an approved EPG).
 * - `REVISED_EQUIPMENT` → parent is a `RevisedEquipmentProjectGroup`
 *                         (chained RELPG-to-RELPG fork, if a subsequent
 *                         revision of an RELPG is ever created).
 *
 * Source of truth: CLAUDE.md §14 (Version Lineage Immutability), §14.7
 * (detection SQL), §5.3 (equipment sub-type — Phase 3 RELPG).
 */
export enum PrevEquipmentProjectType {
  EQUIPMENT = 'equipment',
  REVISED_EQUIPMENT = 'revised_equipment',
}
