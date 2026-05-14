import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddLocalAdministrativeOrganizationIdToSupplementProjectGroups
 *   — task `SUPP_SPG_LAO_COLUMN` (2026-05-12).
 *
 * Adds a nullable `local_administrative_organization_id` column + FK to
 * `local_administrative_organizations(id)` on the `supplement_project_groups`
 * (SPG) table, bringing it into shape-symmetry with `project_groups` (PG) and
 * `revised_project_groups` (RPG) which already carry the same creator-LAO
 * column (see PG entity line 151-161 / RPG entity line 162-171).
 *
 * Business purpose:
 *   - Aggregator + filter queries can match on the denormalized column
 *     directly instead of JOINing through `createdBy.workHistory`.
 *   - SPG becomes shape-symmetric with PG / RPG so that future scope-widening
 *     work (admitting coordinated LAOs into the supplement gate) does not
 *     require a follow-up schema change.
 *
 * Design decisions:
 *   - Column is NULLABLE. Historical rows are backfilled from the creator's
 *     `work_history.local_admistrative_organization_org_id` (note: the
 *     `work_history` column literally carries the historical typo
 *     "admistrative" — preserved verbatim, this is the production column
 *     name. See `WorkHistory` entity line 53).
 *   - Backfill is idempotent — guarded by `local_administrative_organization_id
 *     IS NULL`, so a re-run is a no-op.
 *   - FK: `ON UPDATE CASCADE`, `ON DELETE CASCADE` (matches PG / RPG
 *     `localAdministrativeOrganization` relation — see PG entity line 151-161
 *     and RPG entity line 162-171). The amphoe FK on SPG diverges to
 *     `SET NULL` because amphoe is geo-master data; LAO is creator-context
 *     master data and matches the PG / RPG cascade policy.
 *   - Column type is `varchar(255)` to match the column shape TypeORM
 *     emits for the PG / RPG `local_administrative_organization_id`
 *     columns (created via `synchronize: true` from the
 *     `@ManyToOne(() => LocalAdministrativeOrganization)` relation against
 *     a `@PrimaryColumn() id: string` PK that defaults to `varchar(255)`).
 *   - Index added on the new column for filter-query performance.
 *
 * §5 immutability:
 *   Column is set at INSERT only (service-layer change in the same task).
 *   The update path does NOT mutate this column — DTO does not accept it.
 *   This is enforced by code; no DB trigger is added because the existing
 *   PG / RPG sibling columns rely on the same code-level discipline.
 *
 * Rollback safety:
 *   Down migration drops the FK, then the index, then the column, in
 *   strict LIFO order. No data loss risk — the column starts NULL on a
 *   fresh DB; on a previously-up-migrated DB the data is reconstructible
 *   by re-running the same backfill query (the source `work_history` row
 *   is the source of truth).
 *
 * §14 / §15:
 *   DDL column-add is not a row mutation; lineage and book-lineage
 *   immutability locks do not apply. The backfill UPDATE writes only to
 *   the new column on rows that the lineage lock would not gate (the
 *   creator-context column is set-once at INSERT, not workflow state).
 *
 * §17.13 PII:
 *   `local_administrative_organization_id` is organization-level metadata,
 *   not a person identifier. No new PII path is introduced.
 */
export class AddLocalAdministrativeOrganizationIdToSupplementProjectGroups1751000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Add nullable `local_administrative_organization_id` column.
    // Matches the column type emitted by TypeORM `synchronize: true` for
    // the PG / RPG sibling columns referencing
    // `local_administrative_organizations.id` (varchar PK, length 255 by
    // TypeORM default).
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        ADD COLUMN IF NOT EXISTS "local_administrative_organization_id"
        character varying(255) DEFAULT NULL;
    `);

    // Step 2: Add FK -> local_administrative_organizations(id).
    // ON UPDATE CASCADE / ON DELETE CASCADE mirrors the PG / RPG
    // `localAdministrativeOrganization` relation.
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        ADD CONSTRAINT
          "FK_supplement_project_groups_local_administrative_organization_id"
        FOREIGN KEY ("local_administrative_organization_id")
        REFERENCES "local_administrative_organizations"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;
    `);

    // Step 3: Index for filter-query performance.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_supplement_project_groups_local_administrative_organization_id"
        ON "supplement_project_groups" ("local_administrative_organization_id");
    `);

    // Step 4: Backfill historical rows from the creator's WorkHistory.
    //
    // Idempotent — guarded by `IS NULL` so a re-run only touches rows that
    // have not yet been backfilled. Rows whose creator's WorkHistory has
    // no LAO remain NULL (data-integrity edge case; expected count ≈ 0
    // since §1 classification requires every WorkHistory to carry a LAO).
    //
    // NOTE: the SPG `create_by` column links to `work_history.id`
    // (singular table name, see entity line 32). The LAO FK column on
    // `work_history` is literally named
    // `local_admistrative_organization_org_id` (production typo —
    // preserved verbatim; see WorkHistory entity line 53). The two
    // identifiers below are intentional and MUST NOT be "corrected".
    await queryRunner.query(`
      UPDATE "supplement_project_groups" AS spg
         SET "local_administrative_organization_id" =
             wh."local_admistrative_organization_org_id"
        FROM "work_history" AS wh
       WHERE spg."create_by" = wh."id"
         AND spg."local_administrative_organization_id" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop FK first, then index, then column (strict LIFO order). No
    // data loss risk — backfill is reconstructible from the source
    // `work_history.local_admistrative_organization_org_id` column.
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        DROP CONSTRAINT IF EXISTS
          "FK_supplement_project_groups_local_administrative_organization_id";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS
        "IDX_supplement_project_groups_local_administrative_organization_id";
    `);

    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        DROP COLUMN IF EXISTS "local_administrative_organization_id";
    `);
  }
}
