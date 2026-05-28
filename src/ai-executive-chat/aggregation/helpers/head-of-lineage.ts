/**
 * Wave 57 W57-BE-AGG-01 — HEAD-of-lineage predicate helpers.
 *
 * CLAUDE.md references:
 *   - §11 Versioning Rule
 *   - §14.1 Lineage Definition
 *   - §14.2 Immutability Invariant — HEAD = (live PG with no live RPG
 *     'original' descendant) UNION (live RPG with no live RPG 'revised'
 *     descendant).
 *
 * These helpers compose the canonical anti-join predicate used by
 * `UnifiedProjectAggregator` (loadMain / loadRevised) and let the
 * legacy Tier B tools apply the same HEAD filter without raw SQL.
 *
 * Wave 54 no-raw-SQL gate compatibility: every JOIN target is an entity
 * class (RevisedProjectGroup) — no bareword table literals appear in
 * the predicate strings.
 *
 * §17.2 advisory-only — these helpers do not gate any workflow
 * transition. The advisory `head-of-lineage-applied` is emitted by the
 * caller envelope when dedup actually runs.
 */
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';

/** Public advisory string emitted when HEAD dedup ran. */
export const HEAD_OF_LINEAGE_ADVISORY = 'head-of-lineage-applied' as const;

/**
 * Apply the §14.2 HEAD anti-join to a `ProjectGroup` query builder.
 *
 * `pgAlias` MUST be the alias used when constructing the QB (e.g. 'pg').
 * `descAlias` is the join alias for the descendant probe — defaults to
 * `'pg_desc'`. Callers may override only when nesting multiple HEAD
 * filters on the same QB.
 */
export function applyHeadFilterForProjectGroup<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  pgAlias = 'pg',
  descAlias = 'pg_desc_w57',
): SelectQueryBuilder<T> {
  return qb
    .leftJoin(
      RevisedProjectGroup,
      descAlias,
      `${descAlias}.prev_project_id = ${pgAlias}.id ` +
        `AND ${descAlias}.prev_project_type = 'original' ` +
        `AND ${descAlias}.deleted_at IS NULL`,
    )
    .andWhere(`${descAlias}.id IS NULL`);
}

/**
 * Apply the §14.2 HEAD anti-join to a `RevisedProjectGroup` query
 * builder. `rpgAlias` MUST be the alias used when constructing the QB
 * (e.g. 'rpg'). `descAlias` defaults to `'rpg_desc_w57'`.
 */
export function applyHeadFilterForRevisedProjectGroup<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  rpgAlias = 'rpg',
  descAlias = 'rpg_desc_w57',
): SelectQueryBuilder<T> {
  return qb
    .leftJoin(
      RevisedProjectGroup,
      descAlias,
      `${descAlias}.prev_project_id = ${rpgAlias}.id ` +
        `AND ${descAlias}.prev_project_type = 'revised' ` +
        `AND ${descAlias}.deleted_at IS NULL`,
    )
    .andWhere(`${descAlias}.id IS NULL`);
}

// ────────────────────────────────────────────────────────────────────
// Wave 60 W60-BE-AGG-01 — `isHead` projection helpers (book-completeness mode).
//
// Where `applyHeadFilterFor*` filters the result set to ONLY HEAD rows
// (anti-join with a `WHERE desc.id IS NULL`), the `selectIsHeadFor*`
// helpers below KEEP every row and instead materialize the §14.2
// invariant as a per-row boolean projection. Used by `listProjectsInPlan`
// when the caller asks for `groupBy='byBookCompleteness'` so historical
// rows remain visible while the LLM still knows whether each row is the
// HEAD-of-lineage for its conceptual project.
//
// The same anti-join LEFT JOIN pattern is reused — only the WHERE clause
// is dropped, and a `CASE WHEN <descAlias>.id IS NULL THEN true ELSE
// false END` expression is added to the SELECT projection under the
// alias supplied by the caller (default `ishead`).
//
// Wave 54 no-raw-SQL gate: the JOIN target is the entity class itself
// (`RevisedProjectGroup`); no bareword table literal appears in the
// JOIN condition string.
// ────────────────────────────────────────────────────────────────────

export const IS_HEAD_ALIAS_DEFAULT = 'ishead' as const;

/**
 * Project an `isHead` boolean for a `ProjectGroup` row.
 *
 * `pgAlias` MUST match the QB primary alias (e.g. 'pg'). `descAlias`
 * defaults to `'pg_desc_w60'` so it does NOT collide with the W57 HEAD
 * filter alias if both were ever applied to the same QB.
 */
export function selectIsHeadForProjectGroup<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  pgAlias = 'pg',
  descAlias = 'pg_desc_w60',
  outAlias: string = IS_HEAD_ALIAS_DEFAULT,
): SelectQueryBuilder<T> {
  return qb
    .leftJoin(
      RevisedProjectGroup,
      descAlias,
      `${descAlias}.prev_project_id = ${pgAlias}.id ` +
        `AND ${descAlias}.prev_project_type = 'original' ` +
        `AND ${descAlias}.deleted_at IS NULL`,
    )
    .addSelect(
      `CASE WHEN ${descAlias}.id IS NULL THEN true ELSE false END`,
      outAlias,
    );
}

/**
 * Project an `isHead` boolean for a `RevisedProjectGroup` row.
 *
 * `rpgAlias` MUST match the QB primary alias (e.g. 'rpg'). `descAlias`
 * defaults to `'rpg_desc_w60'`.
 */
export function selectIsHeadForRevisedProjectGroup<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  rpgAlias = 'rpg',
  descAlias = 'rpg_desc_w60',
  outAlias: string = IS_HEAD_ALIAS_DEFAULT,
): SelectQueryBuilder<T> {
  return qb
    .leftJoin(
      RevisedProjectGroup,
      descAlias,
      `${descAlias}.prev_project_id = ${rpgAlias}.id ` +
        `AND ${descAlias}.prev_project_type = 'revised' ` +
        `AND ${descAlias}.deleted_at IS NULL`,
    )
    .addSelect(
      `CASE WHEN ${descAlias}.id IS NULL THEN true ELSE false END`,
      outAlias,
    );
}

// ────────────────────────────────────────────────────────────────────
// Wave AI-Exec-Chat-Book-Coverage BE-01 (2026-05-28) — SPG head-of-
// lineage helper. Mirrors `applyHeadFilterForProjectGroup` but uses
// `prev_project_type = 'supplement'` per CLAUDE.md §14.1 (SPG is a
// lineage root since Wave SUPP-4, 2026-05-24). An SPG is HEAD when no
// non-soft-deleted RevisedProjectGroup row references it via
// `prev_project_id` + `prev_project_type = 'supplement'`.
//
// Wave 54 no-raw-SQL gate: JOIN target is an entity class
// (RevisedProjectGroup); no bareword table literal appears in the
// predicate string.
// ────────────────────────────────────────────────────────────────────

/**
 * Apply the §14.2 HEAD anti-join to a `SupplementProjectGroup` query
 * builder.
 *
 * `spgAlias` MUST be the alias used when constructing the QB (e.g.
 * 'spg'). `descAlias` defaults to `'spg_desc_be01'` to avoid collision
 * with the W57/W60 RPG aliases if both ever appear on the same QB.
 */
export function applyHeadFilterForSupplementProjectGroup<
  T extends ObjectLiteral,
>(
  qb: SelectQueryBuilder<T>,
  spgAlias = 'spg',
  descAlias = 'spg_desc_be01',
): SelectQueryBuilder<T> {
  return qb
    .leftJoin(
      RevisedProjectGroup,
      descAlias,
      `${descAlias}.prev_project_id = ${spgAlias}.id ` +
        `AND ${descAlias}.prev_project_type = 'supplement' ` +
        `AND ${descAlias}.deleted_at IS NULL`,
    )
    .andWhere(`${descAlias}.id IS NULL`);
}
