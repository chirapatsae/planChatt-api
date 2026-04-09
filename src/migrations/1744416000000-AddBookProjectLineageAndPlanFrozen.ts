import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddBookProjectLineageAndPlanFrozen
 *
 * Implements the database layer for the Book Assembly Freeze & Rollback
 * Enforcement feature (BOOK_ASSEMBLY_FREEZE_AND_ROLLBACK_ENFORCEMENT.md).
 *
 * Changes applied:
 *
 * 1. New table: book_project_lineage
 *    Tracks the current leaf status of every project across all published book
 *    versions. This is the O(1) lookup mechanism for the rollback guard
 *    (Rule 4), correction guard (Rule 5), and single-effective-book exclusivity
 *    check (Rule 2).
 *
 * 2. New column: development_plan.is_frozen
 *    Denormalized cache flag, set true when the first DevelopmentPlanRevision
 *    is created for this plan. Enables fast UI filtering without a JOIN.
 *    The backend service MUST still use the authoritative check (existence of
 *    any DevelopmentPlanRevision row) and MUST NOT rely solely on this flag.
 *
 * FK design for parent_book_version_id (nullable):
 *   ON DELETE SET NULL — if a parent BookAssemblyVersion is removed (unusual
 *   but possible in rollback/deprecation flows), the lineage link is set to
 *   null rather than cascading a delete to the child lineage rows. This
 *   preserves the child rows for audit purposes and matches the business rule
 *   that audit history must not be silently destroyed.
 *
 * Partial unique index idx_bpl_one_leaf_per_project:
 *   Enforces that at most one row per (project_id, project_type) may have
 *   is_current_leaf = true. Declared as raw SQL because TypeORM does not
 *   support partial unique indexes via decorator.
 */
export class AddBookProjectLineageAndPlanFrozen1744416000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Create book_project_lineage_project_type_enum ────────────────

    await queryRunner.query(`
      CREATE TYPE "book_project_lineage_project_type_enum" AS ENUM (
        'project_group',
        'revised_project_group'
      );
    `);

    // ── Step 2: Create book_project_lineage table ────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "book_project_lineage" (
        "id"                     uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "project_id"             uuid        NOT NULL,
        "project_type"           "book_project_lineage_project_type_enum" NOT NULL,
        "book_version_id"        uuid        NOT NULL,
        "parent_book_version_id" uuid,
        "is_current_leaf"        boolean     NOT NULL DEFAULT false,
        "created_at"             TIMESTAMP   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_book_project_lineage" PRIMARY KEY ("id")
      );
    `);

    // ── Step 3: Add FK on book_version_id ────────────────────────────────────
    // ON DELETE RESTRICT: a BookAssemblyVersion that has lineage rows must not
    // be deleted. Lineage rows are the source of truth for leaf state — silent
    // deletion would break rollback and correction guards.

    await queryRunner.query(`
      ALTER TABLE "book_project_lineage"
        ADD CONSTRAINT "FK_bpl_book_version"
          FOREIGN KEY ("book_version_id")
          REFERENCES "book_assembly_versions" ("id")
          ON DELETE RESTRICT
          ON UPDATE NO ACTION;
    `);

    // ── Step 4: Add FK on parent_book_version_id (nullable) ──────────────────
    // ON DELETE SET NULL: if the parent version is removed, preserve the child
    // lineage row (audit requirement) but clear the now-dangling pointer.

    await queryRunner.query(`
      ALTER TABLE "book_project_lineage"
        ADD CONSTRAINT "FK_bpl_parent_book_version"
          FOREIGN KEY ("parent_book_version_id")
          REFERENCES "book_assembly_versions" ("id")
          ON DELETE SET NULL
          ON UPDATE NO ACTION;
    `);

    // ── Step 5: Regular indexes ───────────────────────────────────────────────

    // Lookup by project — used by rollback guard and correction guard
    await queryRunner.query(`
      CREATE INDEX "idx_bpl_project"
        ON "book_project_lineage" ("project_id", "project_type");
    `);

    // Lookup by book version — used when deprecating/rolling back a version to
    // find all projects that must have their leaf flag cleared
    await queryRunner.query(`
      CREATE INDEX "idx_bpl_version"
        ON "book_project_lineage" ("book_version_id");
    `);

    // Lookup by parent version — used for descendant queries to determine
    // whether a given book version has any child books depending on it
    await queryRunner.query(`
      CREATE INDEX "idx_bpl_parent_version"
        ON "book_project_lineage" ("parent_book_version_id");
    `);

    // ── Step 6: Partial unique index — one leaf per project ───────────────────
    // Enforces the business invariant: at most one book_project_lineage row per
    // (project_id, project_type) may have is_current_leaf = true at any time.
    // This cannot be expressed as a TypeORM @Unique decorator because TypeORM
    // does not support partial unique indexes.

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_bpl_one_leaf_per_project"
        ON "book_project_lineage" ("project_id", "project_type")
        WHERE "is_current_leaf" = true;
    `);

    // ── Step 7: Add is_frozen to development_plan ────────────────────────────
    // Denormalized cache. Set by service when first DevelopmentPlanRevision is
    // created. Authoritative check is always the existence of a revision row.

    await queryRunner.query(`
      ALTER TABLE "development_plan"
        ADD COLUMN IF NOT EXISTS "is_frozen" BOOLEAN NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── Reverse Step 7 ────────────────────────────────────────────────────────

    await queryRunner.query(`
      ALTER TABLE "development_plan"
        DROP COLUMN IF EXISTS "is_frozen";
    `);

    // ── Reverse Steps 6, 5, 4, 3, 2 (DROP TABLE CASCADE removes FKs and
    //    indexes that are stored on the table itself; we still drop the two
    //    cross-table FK constraints explicitly first to be safe) ───────────────
    //
    // PostgreSQL DROP TABLE ... CASCADE drops dependent objects including FKs
    // declared on OTHER tables that reference this one. However, the FKs here
    // are ON book_project_lineage itself (referencing book_assembly_versions),
    // so CASCADE is not strictly required for FK cleanup. DROP TABLE CASCADE is
    // used for safety in case any view or other dependency was added later.

    await queryRunner.query(`
      DROP TABLE IF EXISTS "book_project_lineage" CASCADE;
    `);

    // ── Drop enum type ────────────────────────────────────────────────────────

    await queryRunner.query(`
      DROP TYPE IF EXISTS "book_project_lineage_project_type_enum";
    `);
  }
}
