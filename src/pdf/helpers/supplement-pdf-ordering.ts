/**
 * SUPP_PRINT_BE_02 — Deterministic ordering helper for supplement PDF assembly.
 *
 * Shared between:
 *   - `report-supplement-detail*.part.ts` (renderer)
 *   - `SupplementPdfService.generateSupplementApprovedFromStatus`
 *     (BE_01: 1..N page-number assignment at finalize)
 *
 * The helper guarantees a stable byte-identical sort so that:
 *   1. The page number stamped into each SPG row at finalize matches the
 *      page where that project actually renders inside the assembled PDF.
 *   2. Re-running finalize on the same data produces an identical PDF
 *      (idempotency / audit).
 *
 * Sort key (deterministic, format-aware):
 *
 *   STRATEGY_BASED:
 *     1) strategy.id ASC  (string-keyed natural code; Strategy/Tactic/Plan
 *        use compact string codes such as "01" / "02" — see entity defs)
 *     2) tactic.id   ASC
 *     3) plan.id     ASC
 *     4) project.createdAt ASC  (older first within the group)
 *     5) project.id  ASC  (UUID tie-breaker for same-millisecond ties)
 *
 *   ISSUE_BASED:
 *     1) developmentIssue.sortOrder ASC (DevelopmentIssue declares `sortOrder`)
 *     2) developmentIssue.id        ASC (tie-break inside same sortOrder)
 *     3) project.createdAt          ASC
 *     4) project.id                 ASC
 *
 * Soft-deleted projects are NOT filtered here — callers must pre-filter via
 * the repository query (`deletedAt IS NULL`). The helper is pure and
 * synchronous.
 *
 * NOTE: CLAUDE.md §16.5 invariant (exactly-one-shape) is the caller's
 * responsibility. If a row violates the invariant (e.g. STRATEGY_BASED row
 * is missing strategy / tactic / plan) the comparator falls back to empty
 * strings and continues to sort deterministically. The renderer is expected
 * to throw PROJECT_CLASSIFICATION_SHAPE_MISMATCH separately.
 */

import { ReportFormat } from 'src/development-plan/types/report-format.enum';

/**
 * Minimal SPG shape consumed by the comparator. Loosely typed so that
 * either a raw entity OR a mapped DTO can be passed in.
 */
export interface SupplementSortable {
  id: string;
  createdAt: Date | string;
  // Strategy/Tactic/Plan declare `id: string` only (see strategy.entity.ts /
  // tactic.entity.ts / plan.entity.ts). Their ids are compact natural codes
  // (e.g. "01" / "02") used as the primary sort key in the existing
  // STRATEGY_BASED PDF pipeline. `name` is preserved for diagnostics only.
  strategy?: { id?: string | null; name?: string | null } | null;
  tactic?: { id?: string | null; name?: string | null } | null;
  plan?: { id?: string | null; name?: string | null } | null;
  // DevelopmentIssue declares both `sortOrder` and `id` (see development-issue.entity.ts).
  developmentIssue?: {
    id?: string | null;
    sortOrder?: number | null;
    name?: string | null;
  } | null;
}

const safeSortOrder = (so: number | null | undefined): number =>
  typeof so === 'number' && Number.isFinite(so) ? so : Number.MAX_SAFE_INTEGER;

const safeStr = (s: string | null | undefined): string =>
  typeof s === 'string' ? s : '';

const toMs = (d: Date | string): number => {
  const v = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(v) ? v : 0;
};

const compareString = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * Deterministic comparator for STRATEGY_BASED supplement rows.
 * Primary key: strategy.id → tactic.id → plan.id (natural codes).
 */
export const compareSupplementStrategyBased = <T extends SupplementSortable>(
  a: T,
  b: T,
): number => {
  const sIdCmp = compareString(safeStr(a.strategy?.id), safeStr(b.strategy?.id));
  if (sIdCmp !== 0) return sIdCmp;

  const tIdCmp = compareString(safeStr(a.tactic?.id), safeStr(b.tactic?.id));
  if (tIdCmp !== 0) return tIdCmp;

  const pIdCmp = compareString(safeStr(a.plan?.id), safeStr(b.plan?.id));
  if (pIdCmp !== 0) return pIdCmp;

  const dA = toMs(a.createdAt);
  const dB = toMs(b.createdAt);
  if (dA !== dB) return dA - dB;

  return compareString(a.id, b.id);
};

/**
 * Deterministic comparator for ISSUE_BASED supplement rows.
 * Primary key: developmentIssue.sortOrder → developmentIssue.id.
 */
export const compareSupplementIssueBased = <T extends SupplementSortable>(
  a: T,
  b: T,
): number => {
  const sA = safeSortOrder(a.developmentIssue?.sortOrder);
  const sB = safeSortOrder(b.developmentIssue?.sortOrder);
  if (sA !== sB) return sA - sB;

  const idCmp = compareString(safeStr(a.developmentIssue?.id), safeStr(b.developmentIssue?.id));
  if (idCmp !== 0) return idCmp;

  const dA = toMs(a.createdAt);
  const dB = toMs(b.createdAt);
  if (dA !== dB) return dA - dB;

  return compareString(a.id, b.id);
};

/**
 * Sort approved supplement projects (SPG) deterministically for PDF
 * rendering and page-number assignment.
 *
 * Pure function — does NOT mutate the input array. Caller-friendly for
 * both raw `SupplementProjectGroup` entities and mapped DTOs.
 *
 * @param projects - SPG list (pre-filtered for soft-delete / status)
 * @param reportFormat - parent plan's reportFormat (§16.3)
 * @returns a NEW array sorted per the contract above
 */
export const orderApprovedSupplementsForPdf = <T extends SupplementSortable>(
  projects: T[],
  reportFormat: ReportFormat,
): T[] => {
  if (!projects || projects.length === 0) return [];

  const cmp =
    reportFormat === ReportFormat.ISSUE_BASED
      ? compareSupplementIssueBased
      : compareSupplementStrategyBased;

  // Spread first to avoid mutating caller's reference.
  return [...projects].sort(cmp);
};
