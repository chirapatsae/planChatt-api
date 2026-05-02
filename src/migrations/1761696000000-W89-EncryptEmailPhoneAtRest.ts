import { MigrationInterface, QueryRunner } from 'typeorm';
import { encryption, decryption, hashEmail, hashPhone } from '../util/encryption.util';

/**
 * Migration: W89-EncryptEmailPhoneAtRest — Wave 89 Phase 1.
 *
 * Encrypts the `users.email` and `users.phone` columns at rest using the
 * shared AES helper in `src/util/encryption.util.ts`, and adds dedicated
 * deterministic-hash sibling columns (`email_hash`, `phone_hash`) that
 * carry the UNIQUE constraint going forward.
 *
 * Sequencing inside `up()`:
 *   Step 0  Normalize existing plaintext (LOWER+TRIM email; digit-only phone)
 *           BEFORE any column shape change so the post-decrypt value matches
 *           the value used to compute the hash. Pre-flight dedup audit
 *           (`backend/scripts/wave89/audit-email-phone-dedup.sql`) MUST have
 *           returned ZERO rows for both queries before this migration is
 *           dispatched — otherwise Step 0 will trip the legacy case-sensitive
 *           UNIQUE constraint and the whole transaction aborts cleanly.
 *   Step 1  Add `email_hash` / `phone_hash` columns (NULL during backfill).
 *   Step 2  Widen `email` / `phone` to VARCHAR(512) so AES `iv:ciphertext`
 *           fits comfortably (typical AES-256-CBC blob is ~32 + 32 + iv hex).
 *   Step 3  Drop legacy plaintext UNIQUE constraints (auto-named
 *           `users_email_key` / `users_phone_key` in PG convention) — the
 *           plaintext column is about to hold ciphertext and uniqueness
 *           moves to the hash columns.
 *   Step 4  Backfill loop: for each row, encrypt plaintext + compute hash,
 *           write both back atomically inside the migration transaction.
 *   Step 5  Add UNIQUE partial indexes on the hash columns
 *           (`WHERE … IS NOT NULL`) — both columns are nullable.
 *
 * `down()` is best-effort symmetric:
 *   - Drop the unique hash indexes.
 *   - Decrypt every row back to plaintext (uses the SAME `SECRET_KEY` that
 *     was active during `up()`; if the key has rotated since, decryption
 *     will fail and operator MUST roll forward instead of back).
 *   - Drop the hash columns.
 *   - Restore the legacy UNIQUE constraints on plaintext.
 *   - Note: VARCHAR(512) is left in place. The original column was an
 *     unbounded `character varying`, so 512 is a strict superset; no data
 *     is at risk and no truncation needed.
 *   - DOCUMENTED CAVEAT: post-down plaintext is the §13 NORMALIZED form
 *     (lowercase trimmed email; digit-only phone), NOT the original mixed
 *     case / formatted string. That historical formatting was discarded by
 *     Step 0 by design.
 *
 * No PII logging:
 *   The migration never logs raw email / phone values. Only aggregate
 *   counts are emitted (rows seen, rows updated).
 *
 * CLAUDE.md compliance:
 *   - §17.3 Audit separation — schema change only; no `tracking_status`
 *     mutation; no FK introduced.
 *   - §17.11 No role exemption — this is an integrity migration, not a
 *     permission. No role can bypass it once applied.
 */
export class W89EncryptEmailPhoneAtRest1761696000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // --------------------------------------------------------------------
    // Step 0 — Normalize plaintext IN PLACE before encryption.
    //
    // The pre-flight dedup audit must already have confirmed zero
    // collisions; if any duplicates remain these UPDATEs will trip the
    // legacy case-sensitive UNIQUE constraint and the whole migration
    // aborts cleanly inside its transaction.
    //
    // Normalization rules MUST be byte-identical to `hashEmail` /
    // `hashPhone` in `src/util/encryption.util.ts`.
    // --------------------------------------------------------------------
    await queryRunner.query(`
      UPDATE users
         SET email = LOWER(TRIM(email))
       WHERE email IS NOT NULL AND email <> ''
    `);

    await queryRunner.query(`
      UPDATE users
         SET phone = REGEXP_REPLACE(phone, '\\D', '', 'g')
       WHERE phone IS NOT NULL AND phone <> ''
    `);

    // --------------------------------------------------------------------
    // Step 1 — Add hash columns (nullable; backfilled in Step 4).
    // --------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "email_hash" VARCHAR(64) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "phone_hash" VARCHAR(64) NULL
    `);

    // --------------------------------------------------------------------
    // Step 2 — Widen plaintext columns to fit AES `iv:ciphertext` blob.
    // 512 chars is generous — AES-256-CBC of a typical email/phone yields
    // around 80–120 hex chars total, but 512 leaves headroom for any
    // future scheme change without another schema migration.
    // --------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(512)
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "phone" TYPE VARCHAR(512)
    `);

    // --------------------------------------------------------------------
    // Step 3 — Drop legacy UNIQUE constraints on the (now-to-be-ciphertext)
    // plaintext columns. PostgreSQL auto-names UNIQUE constraints
    // `<table>_<column>_key` by default. Use IF EXISTS for idempotency
    // and to tolerate an alternate name surviving from an older bootstrap.
    // --------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_key"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_phone_key"
    `);
    // Defensive: discover and drop any other UNIQUE constraint on these
    // single columns (some bootstraps name them differently).
    await queryRunner.query(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN
          SELECT tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
             AND tc.table_schema = ccu.table_schema
           WHERE tc.table_name = 'users'
             AND tc.constraint_type = 'UNIQUE'
             AND ccu.column_name IN ('email', 'phone')
             AND tc.constraint_name NOT IN (
               'uq_users_email_hash',
               'uq_users_phone_hash'
             )
        LOOP
          EXECUTE format(
            'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS %I',
            r.constraint_name
          );
        END LOOP;
      END$$;
    `);

    // --------------------------------------------------------------------
    // Step 4 — Backfill loop. Read every row with at least one of email /
    // phone non-null, encrypt the (now-normalized) plaintext, compute the
    // HMAC hash, write both back. Runs inside the migration's implicit
    // transaction — atomic across all rows.
    // --------------------------------------------------------------------
    const rows: Array<{ id: string; email: string | null; phone: string | null }> =
      await queryRunner.query(
        `SELECT id, email, phone
           FROM users
          WHERE email IS NOT NULL OR phone IS NOT NULL`,
      );

    let emailEncryptedCount = 0;
    let phoneEncryptedCount = 0;

    for (const row of rows) {
      const setClauses: string[] = [];
      const params: Array<string | null> = [];

      if (row.email && row.email !== '') {
        const cipher = await encryption(row.email);
        const hash = hashEmail(row.email);
        params.push(cipher);
        setClauses.push(`"email" = $${params.length}`);
        params.push(hash);
        setClauses.push(`"email_hash" = $${params.length}`);
        emailEncryptedCount += 1;
      }

      if (row.phone && row.phone !== '') {
        const cipher = await encryption(row.phone);
        const hash = hashPhone(row.phone);
        params.push(cipher);
        setClauses.push(`"phone" = $${params.length}`);
        params.push(hash);
        setClauses.push(`"phone_hash" = $${params.length}`);
        phoneEncryptedCount += 1;
      }

      if (setClauses.length === 0) continue;

      params.push(row.id);
      await queryRunner.query(
        `UPDATE "users" SET ${setClauses.join(', ')} WHERE "id" = $${params.length}`,
        params,
      );
    }

    // Aggregate-only log; no PII.
    // eslint-disable-next-line no-console
    console.log(
      `[W89-DB-MIGRATION] Backfill complete: ${rows.length} rows scanned, ` +
        `${emailEncryptedCount} emails encrypted+hashed, ` +
        `${phoneEncryptedCount} phones encrypted+hashed.`,
    );

    // --------------------------------------------------------------------
    // Step 5 — UNIQUE partial indexes on the hash columns. PARTIAL on
    // `IS NOT NULL` because email and phone are both nullable — multiple
    // NULLs are legitimate.
    // --------------------------------------------------------------------
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_email_hash"
        ON "users" ("email_hash")
        WHERE "email_hash" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_phone_hash"
        ON "users" ("phone_hash")
        WHERE "phone_hash" IS NOT NULL
    `);
    // Non-unique secondary indexes for fast equality lookup (entity-side
    // @Index('idx_users_email_hash')). Created separately so the unique
    // partial index above carries the integrity guarantee while the
    // entity-mapped index name remains a plain b-tree alias.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_users_email_hash"
        ON "users" ("email_hash")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_users_phone_hash"
        ON "users" ("phone_hash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 5') Drop hash indexes.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_phone_hash"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_email_hash"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_users_phone_hash"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_users_email_hash"`);

    // 4') Decrypt loop. Best-effort: requires the same SECRET_KEY that
    // was used during up(). On key rotation, this will throw and the
    // operator MUST roll forward instead of attempting a down().
    const rows: Array<{ id: string; email: string | null; phone: string | null }> =
      await queryRunner.query(
        `SELECT id, email, phone
           FROM users
          WHERE email IS NOT NULL OR phone IS NOT NULL`,
      );

    let emailDecryptedCount = 0;
    let phoneDecryptedCount = 0;

    for (const row of rows) {
      const setClauses: string[] = [];
      const params: Array<string | null> = [];

      if (row.email && row.email !== '') {
        const plain = await decryption(row.email);
        params.push(plain);
        setClauses.push(`"email" = $${params.length}`);
        emailDecryptedCount += 1;
      }
      if (row.phone && row.phone !== '') {
        const plain = await decryption(row.phone);
        params.push(plain);
        setClauses.push(`"phone" = $${params.length}`);
        phoneDecryptedCount += 1;
      }

      if (setClauses.length === 0) continue;

      params.push(row.id);
      await queryRunner.query(
        `UPDATE "users" SET ${setClauses.join(', ')} WHERE "id" = $${params.length}`,
        params,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[W89-DB-MIGRATION] down() decrypted ${emailDecryptedCount} emails ` +
        `and ${phoneDecryptedCount} phones back to plaintext (normalized form).`,
    );

    // 3') Drop hash columns.
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "phone_hash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "email_hash"`);

    // 2') VARCHAR(512) widening is left in place — it is a strict
    // superset of any historical column shape and would only matter if a
    // CHECK constraint relied on the prior bound; none exists.

    // 1') Restore legacy UNIQUE constraints on plaintext.
    // No-op-safe via IF NOT EXISTS-style guard (PG lacks ADD CONSTRAINT
    // IF NOT EXISTS, so wrap in DO $$).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
           WHERE table_name = 'users'
             AND constraint_name = 'users_email_key'
        ) THEN
          ALTER TABLE "users"
            ADD CONSTRAINT "users_email_key" UNIQUE ("email");
        END IF;
      END$$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
           WHERE table_name = 'users'
             AND constraint_name = 'users_phone_key'
        ) THEN
          ALTER TABLE "users"
            ADD CONSTRAINT "users_phone_key" UNIQUE ("phone");
        END IF;
      END$$;
    `);
  }
}
