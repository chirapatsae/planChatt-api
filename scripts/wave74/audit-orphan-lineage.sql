-- ============================================================================
-- W74 — Read-only audit: orphan lineage FKs in revised_project_groups
-- ============================================================================
--
-- WHAT THIS SCRIPT DOES
--   Inspects rows in `revised_project_groups` where the §14 lineage FK
--   columns (`prev_project_id`, `prev_project_type`) are NULL or only
--   half-populated. Provides counts, an itemized list, a temporal
--   distribution, a half-populated sanity check, and a recent-window
--   regression check.
--
-- WHY IT EXISTS
--   Wave W74 dispatched in response to a user report that some rows in
--   the production DB show NULL `prev_project_id` / `prev_project_type`.
--   The CTO confirmed the CURRENT code path persists both columns (DTO
--   `@IsNotEmpty()` + service explicit assignment + frontend payload),
--   so any orphan rows are pre-§14 historical data. This audit lets the
--   operator confirm the volume and dating of orphan rows and decide
--   whether a follow-up backfill wave is justified.
--
-- WHEN IT IS SAFE TO RUN
--   Anytime. This script is READ-ONLY by construction — every statement
--   is a SELECT. There are NO INSERT / UPDATE / DELETE / DDL statements.
--   It MAY be run on production directly.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -f backend/scripts/wave74/audit-orphan-lineage.sql
--
-- REFERENCE
--   CLAUDE.md §14.1 Lineage Definition — lineage link is stored via
--   `revised_project_groups.prev_project_id` (UUID) and
--   `revised_project_groups.prev_project_type` ('original' | 'revised').
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Query A — Total orphan count
-- ----------------------------------------------------------------------------
-- Single-number summary: how many non-soft-deleted rows are missing one or
-- both lineage FK columns. Use this as the headline number.
SELECT COUNT(*) AS orphan_count
FROM revised_project_groups
WHERE deleted_at IS NULL
  AND (prev_project_id IS NULL OR prev_project_type IS NULL);


-- ----------------------------------------------------------------------------
-- Query B — Orphan rows itemized
-- ----------------------------------------------------------------------------
-- Full row inspection so the operator can manually trace each orphan back
-- to its likely parent (e.g., by matching on title / DPR / created_at).
-- Note: `revised_project_groups` has no `updated_at` column on the entity,
-- so it is intentionally omitted.
SELECT
  id,
  title,
  prev_project_id,
  prev_project_type,
  development_plan_revision_id,
  created_at
FROM revised_project_groups
WHERE deleted_at IS NULL
  AND (prev_project_id IS NULL OR prev_project_type IS NULL)
ORDER BY created_at ASC;


-- ----------------------------------------------------------------------------
-- Query C — Distribution by created_at month
-- ----------------------------------------------------------------------------
-- Helps identify whether orphans cluster around a specific deployment
-- window. The CTO's working hypothesis is that orphans precede §14 / W57;
-- a clean cliff at the W57 deploy date would confirm that hypothesis.
SELECT
  DATE_TRUNC('month', created_at) AS month,
  COUNT(*) AS orphan_count
FROM revised_project_groups
WHERE deleted_at IS NULL
  AND (prev_project_id IS NULL OR prev_project_type IS NULL)
GROUP BY DATE_TRUNC('month', created_at)
ORDER BY month ASC;


-- ----------------------------------------------------------------------------
-- Query D — Half-populated sanity check
-- ----------------------------------------------------------------------------
-- The two FK columns SHOULD always move in lockstep — if one is set, both
-- should be. A non-zero count here indicates a real integrity bug
-- (something wrote one column without the other). Investigate any non-zero
-- result before drawing conclusions from Query A.
SELECT COUNT(*) AS half_populated_count
FROM revised_project_groups
WHERE deleted_at IS NULL
  AND (
    (prev_project_id IS NOT NULL AND prev_project_type IS NULL)
    OR (prev_project_id IS NULL AND prev_project_type IS NOT NULL)
  );


-- ----------------------------------------------------------------------------
-- Query E — Recent rows (last 30 days)
-- ----------------------------------------------------------------------------
-- The CTO's diagnosis is that orphans are pre-§14 only. Rows created in
-- the last 30 days SHOULD all have both FK columns populated. If
-- `recent_orphan > 0`, the "no live bug" verdict needs revisiting because
-- the current code path should never produce an orphan row.
SELECT
  COUNT(*) FILTER (
    WHERE prev_project_id IS NOT NULL AND prev_project_type IS NOT NULL
  ) AS recent_populated,
  COUNT(*) FILTER (
    WHERE prev_project_id IS NULL OR prev_project_type IS NULL
  ) AS recent_orphan
FROM revised_project_groups
WHERE deleted_at IS NULL
  AND created_at >= NOW() - INTERVAL '30 days';
