import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVersionSourceStatusIndex1744243200000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite index covering (source_type, source_id, status) for the
    // NOT EXISTS subquery used in sidebar count computation.
    //
    // The count queries filter book_assembly_versions on all three columns:
    //   WHERE source_type = ? AND source_id = ? AND status = 'completed'
    //
    // Existing idx_version_source covers only (source_type, source_id),
    // requiring a heap fetch for the status predicate. This index enables
    // an index-only scan on the full predicate set.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_version_source_status"
       ON "book_assembly_versions" ("source_type", "source_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_version_source_status"`,
    );
  }
}
