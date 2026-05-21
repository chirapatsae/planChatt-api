// ===================================================================
// External Alignment Block
// -------------------------------------------------------------------
// Renders the five-row alignment header (ก. ยุทธศาสตร์ชาติ / ข. แผน
// พัฒนาเศรษฐกิจฯ / ค. SDG / ง. ยุทธศาสตร์จังหวัด / จ. ยุทธศาสตร์การพัฒนา
// ของ อปท.) injected ABOVE the existing Strategy/Tactic/Plan stack
// (the จ. row mirrors the same internal Strategy that the stack
// displays — they are intentionally redundant per the source-of-truth
// document template).
//
// Per-row format is a SINGLE full-width line with the canonical Thai
// label, the numeric ordinal extracted from the entity code, then the
// entity Thai name. The ordinal is derived from the `code` field:
// `NS5` → `5`, `MS11` → `11`, `SDG6` → `6`, `PS4` → `4`, `STRAT001` → `1`.
//
// 2026-05-19 — rewritten per user direction. The previous two-cell
// (label | value) shape was wrong; the official template requires the
// `ก. ข. ค. ง. จ.` numbered single-line shape.
//
// Source of truth: CLAUDE.md §16.8 PDF Rendering Rules,
// PDF_EXTERNAL_ALIGNMENT_UMBRELLA.md (revised 2026-05-19).
//
// Constraints:
//   - STRATEGY_BASED branch only — ISSUE_BASED renderers untouched.
//   - Pure rendering helper; no DB / TrackingStatus / AI side-effects.
// ===================================================================

import type { AlignmentRow } from 'src/project-alignment-mapping/types/alignment.types';

/**
 * Extract the leading numeric ordinal from a code string.
 *   `NS5`      → `'5'`
 *   `MS11`     → `'11'`
 *   `STRAT001` → `'1'` (leading zeros stripped via parseInt)
 *   `null` / no digits → `'—'`
 */
const ordinalFromCode = (code: string | null | undefined): string => {
  if (!code) return '—';
  const match = code.match(/\d+/);
  if (!match) return '—';
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? String(parsed) : '—';
};

/**
 * Compose one numbered line in the form
 *   `<bullet>. <label> <ordinalLabel> <ordinal> <nameTh>`
 */
const composeLine = (
  bullet: string,
  label: string,
  ordinalLabel: string,
  code: string | null | undefined,
  nameTh: string | null | undefined,
): string => {
  const ordinal = ordinalFromCode(code);
  const name = (nameTh ?? '').trim() || '—';
  // Tight Thai punctuation — no space after the leading "ก."
  return `${bullet}.${label} ${ordinalLabel} ${ordinal} ${name}`;
};

/**
 * The internal Strategy of the surrounding (Strategy, Tactic, Plan)
 * group. Passed from the orchestrator so the จ. row can echo the same
 * data the existing `ยุทธศาสตร์:` stack line will render below.
 */
export interface InternalStrategyRef {
  /** Code / id of the Strategy entity, e.g. `STRAT001`. */
  code: string | null;
  /** Thai name of the Strategy. */
  name: string;
}

/**
 * Build the five alignment header rows as a sequence of pdfmake table
 * rows. Each row is a SINGLE cell spanning the full width of the
 * surrounding table.
 *
 * Row order (FROZEN):
 *   1. ก. ยุทธศาสตร์ชาติ 20 ปี ยุทธศาสตร์ที่ {NS#} {NS name}
 *   2. ข. แผนพัฒนาเศรษฐกิจและสังคมแห่งชาติ ฉบับที่ 13
 *         หมุดหมายที่ {MS#} {MS name}
 *   3. ค. Sustainable Development Goals : SDGs
 *         เป้าหมายที่ {SDG#} {SDG name}
 *   4. ง. ยุทธศาสตร์จังหวัดที่ {PS#} {PS name}
 *   5. จ. ยุทธศาสตร์การพัฒนาของ อปท. ในเขตจังหวัดที่
 *         {Strategy#} {Strategy name}
 *
 * @param alignment  resolved alignment row for this (strategy, tactic,
 *                   plan) triple, or `null` if no mapping exists
 * @param strategy   the internal Strategy info for row จ. — pass null
 *                   when unknown (renders ordinal/name as `—`)
 * @param totalColumns  the total number of column slots in the
 *                   surrounding table (already accounts for budget
 *                   year-expansion by the caller)
 */
/**
 * Internal helper — build the 5 alignment lines as plain strings.
 * Shared by both `buildExternalAlignmentRows` (legacy table-row shape)
 * and `buildExternalAlignmentBlock` (standalone content block, used to
 * render ก-จ ONCE above the table so it does NOT repeat on
 * continuation pages via pdfmake `headerRows`).
 */
function buildAlignmentLines(
  alignment: AlignmentRow | null,
  strategy: InternalStrategyRef | null,
): string[] {
  const ns = alignment?.nationalStrategy ?? null;
  const ms = alignment?.milestone ?? null;
  const sdg = alignment?.sdg ?? null;
  const ps = alignment?.provinceStrategy ?? null;

  return [
    composeLine(
      'ก',
      'ยุทธศาสตร์ชาติ 20 ปี',
      'ยุทธศาสตร์ที่',
      ns?.code ?? null,
      ns?.nameTh ?? null,
    ),
    composeLine(
      'ข',
      'แผนพัฒนาเศรษฐกิจและสังคมแห่งชาติ ฉบับที่ 13',
      'หมุดหมายที่',
      ms?.code ?? null,
      ms?.nameTh ?? null,
    ),
    composeLine(
      'ค',
      'Sustainable Development Goals : SDGs',
      'เป้าหมายที่',
      sdg?.code ?? null,
      sdg?.nameTh ?? null,
    ),
    // ง. has no separate "label" segment — the bullet+name carry the
    // canonical phrase. Synthesise a label-less line.
    `ง.ยุทธศาสตร์จังหวัดที่ ${ordinalFromCode(ps?.code ?? null)} ${(ps?.nameTh ?? '').trim() || '—'}`,
    `จ.ยุทธศาสตร์การพัฒนาของ อปท. ในเขตจังหวัดที่ ${ordinalFromCode(strategy?.code ?? null)} ${(strategy?.name ?? '').trim() || '—'}`,
  ];
}

/**
 * Build the ก-จ alignment block as a STANDALONE pdfmake content item
 * (not a table row). Used by callers that want the block to appear
 * ONCE above a table — pdfmake `headerRows` only repeats rows INSIDE
 * the table, so emitting the block outside guarantees it shows only on
 * the first page of each group.
 *
 * The returned block is a `stack` of 5 bold left-aligned lines with
 * zero outer margin. Callers SHOULD wrap it in a pdfmake `stack` along
 * with the table so the two share a single `pageBreak` boundary.
 */
export function buildExternalAlignmentBlock(
  alignment: AlignmentRow | null,
  strategy: InternalStrategyRef | null,
): any {
  const lines = buildAlignmentLines(alignment, strategy);
  return {
    stack: lines.map((text) => ({
      text,
      bold: true,
      alignment: 'left',
      margin: [0, 0, 0, 0],
      // 2026-05-21 — extra breathing room between ก-จ lines. 1.2 ≈ 20%
      // taller than the default single-line box (was 1.3; reduced per
      // user feedback). The STP stack inside the table uses the same
      // 1.2 so the two header blocks share one visual rhythm.
      lineHeight: 1.2,
    })),
    // Match the table's default cell paddingLeft (4pt) so ก-จ aligns
    // with the ยุทธศาสตร์ row that lives as the first body row of the
    // table immediately below.
    margin: [4, 0, 4, 0],
  };
}

export function buildExternalAlignmentRows(
  alignment: AlignmentRow | null,
  strategy: InternalStrategyRef | null,
  totalColumns: number,
): any[][] {
  // Defensive: a zero-column table is degenerate.
  if (totalColumns < 1) {
    return [];
  }

  const lines = buildAlignmentLines(alignment, strategy);

  // 2026-05-21 — collapsed from 5 separate table rows into ONE row
  // containing a `stack` of 5 text items. Mirrors the structure of
  // the immediately-following ยุทธศาสตร์/กลยุทธ์/แผนงาน block (also a
  // single row with a 3-item stack) so the two read as a single
  // flowing list with identical line spacing.
  //
  // Why this matters:
  //   - 5 separate `<tr>`s pick up pdfmake's per-cell vertical padding
  //     (~2pt top + 2pt bottom = 4pt between lines, on top of the
  //     `margin: [4,2,4,2]` we used to set), producing the "blank-row"
  //     gap the user reported.
  //   - The Strategy stack uses default stack `lineHeight` only — no
  //     inter-item padding — so its rows look tight.
  //   - Left margin was `4` (extra 4pt indent on top of cell paddingLeft),
  //     pushing ก-จ further right than ยุทธศาสตร์. Setting `margin: 0`
  //     here makes the two lists share the same left edge.
  const innerRow: any[] = [];
  innerRow.push({
    colSpan: totalColumns,
    stack: lines.map((text) => ({
      text,
      // 2026-05-21 — bolded per user direction so the ก-จ alignment
      // header reads with the same weight as the ยุทธศาสตร์/กลยุทธ์/แผนงาน
      // stack that follows it (the two now form one visually unbroken
      // header band, see paddingTop/paddingBottom overrides in callers).
      bold: true,
      alignment: 'left',
      margin: [0, 0, 0, 0],
    })),
    border: [false, false, false, false],
  });
  for (let i = 1; i < totalColumns; i += 1) {
    innerRow.push({});
  }
  return [innerRow];
}
