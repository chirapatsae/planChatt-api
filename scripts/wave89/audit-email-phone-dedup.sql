-- ============================================================================
-- W89 Pre-Migration Dedup Audit
-- ----------------------------------------------------------------------------
-- Purpose:
--   Detect rows in `users` whose `email` or `phone` would COLLIDE after
--   W89 normalization (LOWER+TRIM for email; digit-only for phone). Such
--   collisions are invisible to today's case-sensitive UNIQUE constraint
--   but WILL crash W89-DB-MIGRATION's Step 0 plaintext UPDATE and the
--   subsequent UNIQUE-on-hash index creation.
--
-- Read-only:
--   This script issues SELECT statements only. It performs NO mutations
--   and is safe to run on a production replica or read-only follower.
--
-- How to run:
--   psql "$DATABASE_URL" -f backend/scripts/wave89/audit-email-phone-dedup.sql
--
--   Or interactively:
--     psql "$DATABASE_URL"
--     \i backend/scripts/wave89/audit-email-phone-dedup.sql
--
-- Operator workflow:
--   1. Run on a recent prod-replica snapshot.
--   2. If BOTH queries return zero rows → safe to proceed with
--      W89-DB-MIGRATION.
--   3. If ANY query returns rows → resolve duplicates manually:
--        - Decide canonical row (typically: the most recently active /
--          highest-completeness profile).
--        - Soft-delete (or rename) the non-canonical row(s).
--        - Re-run this audit until both queries return zero rows.
--   4. Only then run W89-DB-MIGRATION.
--
-- Source of Truth: CLAUDE.md §17.3, §17.11; docs/tasks/wave89/W89-DAG.md;
--                  docs/tasks/wave89/W89-DB-MIGRATION.md
-- ============================================================================

-- -----------------------------------------------------------------------------
-- Email collisions (case-insensitive duplicates after W89 normalization)
-- -----------------------------------------------------------------------------
SELECT LOWER(TRIM(email)) AS norm_email,
       COUNT(*) AS dup_count,
       array_agg(id) AS user_ids,
       array_agg(email) AS original_emails
FROM users
WHERE email IS NOT NULL AND email <> ''
GROUP BY 1
HAVING COUNT(*) > 1
ORDER BY dup_count DESC;

-- -----------------------------------------------------------------------------
-- Phone collisions (digit-only duplicates after W89 normalization)
-- -----------------------------------------------------------------------------
SELECT REGEXP_REPLACE(phone, '\D', '', 'g') AS norm_phone,
       COUNT(*) AS dup_count,
       array_agg(id) AS user_ids,
       array_agg(phone) AS original_phones
FROM users
WHERE phone IS NOT NULL AND phone <> ''
GROUP BY 1
HAVING COUNT(*) > 1
ORDER BY dup_count DESC;
