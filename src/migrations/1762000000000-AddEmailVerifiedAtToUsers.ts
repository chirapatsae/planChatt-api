import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: W95-MIGRATION — Add `users.email_verified_at` + grandfather backfill.
 *
 * Wave 95 introduces email-verification gating on the notification pipeline.
 * This migration is the FOUNDATIONAL schema add (Q10 phase 1: inert schema —
 * no service code reads or writes the column yet; W95-USERS-API and the
 * downstream gate/flow tasks land in subsequent waves).
 *
 * Forward (`up`):
 *   1. ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ NULL DEFAULT NULL
 *   2. UPDATE users SET email_verified_at = NOW() WHERE email_hash IS NOT NULL
 *
 * Reverse (`down`):
 *   1. ALTER TABLE users DROP COLUMN email_verified_at
 *
 * Design notes (per task spec):
 *   - Column type: timestamptz NULL DEFAULT NULL.
 *   - No index in this wave: the gate predicate is a NULL check on a per-
 *     recipient row already loaded by id — an index would not help.
 *   - No CHECK constraint, no FK changes.
 *   - Backfill predicate is `email_hash IS NOT NULL` (W89-conservative). A
 *     row with ciphertext `email` but NULL `email_hash` (malformed legacy
 *     data) will NOT be backfilled and will fall into the unverified bucket;
 *     this is acceptable per spec §11.
 *   - W83 — no PII is logged; backfill never reads plaintext `email`.
 *
 * CLAUDE.md compliance:
 *   - §12 — schema add only; no `tracking_status` writes.
 *   - §17.3 — no FK to project tables; not applicable but consistent.
 *   - §17.11 — integrity migration; no role bypass.
 */
export class AddEmailVerifiedAtToUsers1762000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1 — Add the column. IF NOT EXISTS keeps `up()` idempotent in case
    // an operator re-runs against a partially-applied state.
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMPTZ NULL DEFAULT NULL
    `);

    // Step 2 — Grandfather backfill (Q3). Mark every existing user with a
    // non-null `email_hash` as verified at NOW(). The predicate uses
    // `email_hash IS NOT NULL` (W89), NEVER `email IS NOT NULL`, because:
    //   - `email` may hold ciphertext for rows that lost their hash via
    //     legacy data drift; we cannot trust that as a "had a real email"
    //     signal without decrypting (which W83 forbids in migrations).
    //   - `email_hash` is the deterministic blind index that proves a real
    //     email was once registered through the W89-aware pipeline.
    // The `email_verified_at IS NULL` clause makes the UPDATE idempotent
    // under re-run, in case the column-add step succeeded but the backfill
    // was rolled back by an earlier failed attempt.
    await queryRunner.query(`
      UPDATE "users"
         SET "email_verified_at" = NOW()
       WHERE "email_hash" IS NOT NULL
         AND "email_verified_at" IS NULL
    `);

    // Aggregate-only log; no PII. Re-query to emit a verified-row count
    // (cheap; this is a one-shot migration).
    const countRows: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
        FROM "users"
       WHERE "email_verified_at" IS NOT NULL
    `);
    const verifiedCount = countRows[0]?.count ?? '0';
    // eslint-disable-next-line no-console
    console.log(
      `[W95-MIGRATION] Backfill complete: ${verifiedCount} user rows now ` +
        `have email_verified_at populated (predicate: email_hash IS NOT NULL).`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: drop the column. IF EXISTS keeps `down()` safe under
    // partially-applied / re-run conditions and leaves no orphan data
    // (the column and its backfilled values are removed atomically).
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified_at"
    `);
  }
}
