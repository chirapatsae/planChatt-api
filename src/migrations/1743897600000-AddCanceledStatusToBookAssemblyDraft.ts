import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCanceledStatusToBookAssemblyDraft1743897600000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Extend the PostgreSQL enum type with 'canceled'.
    //
    // ALTER TYPE ... ADD VALUE cannot run inside a transaction in PostgreSQL.
    // TypeORM wraps migrations in a transaction by default, so we must
    // commit the current transaction, run the ALTER TYPE, then re-open
    // a transaction for the remaining DDL statements.
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "assembly_draft_status_enum" ADD VALUE IF NOT EXISTS 'canceled';`,
    );
    await queryRunner.startTransaction();

    // Step 2: Add canceled_at nullable timestamp column.
    // Existing rows get NULL (no data migration needed).
    await queryRunner.query(`
      ALTER TABLE "book_assembly_drafts"
      ADD COLUMN "canceled_at" TIMESTAMP DEFAULT NULL;
    `);

    // Step 3: Add canceled_by_id nullable UUID column.
    await queryRunner.query(`
      ALTER TABLE "book_assembly_drafts"
      ADD COLUMN "canceled_by_id" uuid DEFAULT NULL;
    `);

    // Step 4: Add foreign key referencing work_history(id).
    // ON DELETE SET NULL so that deleting a WorkHistory record
    // does not cascade-delete the draft — only clears the reference.
    await queryRunner.query(`
      ALTER TABLE "book_assembly_drafts"
      ADD CONSTRAINT "FK_draft_canceled_by"
      FOREIGN KEY ("canceled_by_id") REFERENCES "work_history"("id")
      ON DELETE SET NULL;
    `);

    // Step 5: Add partial index for efficient canceled-draft lookups.
    // Queries like getCanceledDraft(sourceType, sourceId) filter by
    // assembly_status = 'canceled' and ORDER BY canceled_at DESC.
    await queryRunner.query(`
      CREATE INDEX "idx_draft_canceled"
      ON "book_assembly_drafts" ("source_type", "source_id")
      WHERE "assembly_status" = 'canceled';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_draft_canceled";`,
    );

    // Drop foreign key
    await queryRunner.query(`
      ALTER TABLE "book_assembly_drafts"
      DROP CONSTRAINT IF EXISTS "FK_draft_canceled_by";
    `);

    // Drop columns
    await queryRunner.query(`
      ALTER TABLE "book_assembly_drafts"
      DROP COLUMN IF EXISTS "canceled_by_id";
    `);

    await queryRunner.query(`
      ALTER TABLE "book_assembly_drafts"
      DROP COLUMN IF EXISTS "canceled_at";
    `);

    // Note: PostgreSQL does not support removing a value from an enum type.
    // The 'canceled' value will remain in the enum after rollback.
    // This is safe — unused enum values cause no harm, and the column
    // constraint plus application logic prevent it from being written.
  }
}
