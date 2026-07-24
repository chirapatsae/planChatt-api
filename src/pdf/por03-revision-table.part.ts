import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import type { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import type { SupplementEquipmentProjectGroup } from 'src/supplement-equipment-project-group/entities/supplement-equipment-project-group.entity';

/**
 * Wave Revision/Change Equipment ผ.03 Print (OLD vs NEW) — BE-01
 * (2026-06-03).
 *
 * ผ.03 OLD/NEW paired-row renderer. Composes the existing ผ.03 column
 * layout (`por03-table.part.ts`) with the revision OLD-vs-NEW comparison
 * FORMAT (`report-revision-edit-detail.part.ts`):
 *   - Column set = the SAME ผ.03 columns as `createPor03DetailDocDefinition`
 *     (ที่ / ครุภัณฑ์ / เป้าหมาย / งบประมาณรายปี per fiscal year /
 *     ผลที่คาดว่าจะได้รับ / หน่วยงานรับผิดชอบ) PLUS a leading
 *     "รายการ" (เดิม / ใหม่) label column so the OLD and NEW rows of a
 *     pair are visually distinguishable, mirroring ผ.02's เดิม/ใหม่
 *     two-table convention adapted to a single equipment table.
 *   - For each RELPG (`current`), the renderer emits TWO data rows:
 *       1. OLD row — values from the lineage `previous` (EPG | RELPG).
 *          When `previous` is null (no lineage parent), the OLD row's
 *          equipment-content cells render blank (the index + label are
 *          still shown so the comparison structure stays intact).
 *       2. NEW row — values from `current` (the RELPG). Changed cells
 *          are emphasized in bold (`hasChanged` against `previous`),
 *          reusing the ผ.02 change-emphasis convention.
 *
 * Grouping / sort ordering is IDENTICAL to `createPor03DetailDocDefinition`
 * — the service supplies pre-grouped `EquipmentRevisionTableGroup[]` from
 * the SAME `Por03PdfService.groupRows` machinery so ผ.03 ordering does
 * not drift between the two print surfaces.
 *
 * Top-right "แบบ ผ.03" stamp on every page (header function) and NO page
 * numbers (footer returns null) — same locked decision as the Phase 2.5
 * print surface (README §12 / §5.3 Phase 2.5).
 *
 * Read-only render primitive — produces a `TDocumentDefinitions` only;
 * NO DB access, NO writes (§17.2).
 */

/**
 * A single OLD/NEW pair: the RELPG and its resolved lineage parent.
 * `previous` is `null` when the RELPG has no lineage parent (or the
 * parent is soft-deleted) — the OLD column then renders blank.
 */
export interface EquipmentRevisionPair {
  current: RevisedEquipmentProjectGroup;
  // Wave SUPP-4 (equipment) — `previous` may be a SupplementEquipmentProjectGroup
  // when the RELPG was forked from an SEPG (ครุภัณฑ์ เล่มเพิ่มเติม). The OLD-row
  // renderer duck-types the shared equipment fields, so the SEPG shape works.
  previous:
    | EquipmentProjectGroup
    | RevisedEquipmentProjectGroup
    | SupplementEquipmentProjectGroup
    | null;
}

/**
 * Grouping shape for the OLD/NEW renderer — keyed by (Category, Tactic,
 * Plan) of the CURRENT (RELPG) row, mirroring `EquipmentTableGroup`. The
 * display fields are resolved from the current row at grouping time.
 */
export interface EquipmentRevisionTableGroup {
  categoryCode: number;
  categoryName: string;
  tacticName: string;
  planName: string;
  pairs: EquipmentRevisionPair[];
}

export interface Por03RevisionDetailDocParams {
  developmentPlanName: string;
  groups: EquipmentRevisionTableGroup[];
  years: number[];
  newWord: (text: string) => any;
  /**
   * Phase (2026-06-04, wave-edit-change-assembly-por03-append):
   * continuous absolute-page offset (sum of ผ.01 + ผ.02 + ผ.02-Part3
   * page counts). When set, the footer renders `currentPage + pageOffset`
   * in the ผ.02 style so the appended ผ.03 revision section continues the
   * merged-book page sequence. When omitted (Phase 2.5/2.6 print /
   * staff-draft surfaces) the footer returns null per the locked decision.
   */
  pageOffset?: number;
  /**
   * When false, suppress the centered cover block so per-group buffers do
   * not repeat it (used by the GROUP-LEVEL render loop in
   * `renderApprovedRevisionScopedPor03Buffer`). Default true.
   */
  includeCoverBlock?: boolean;
}

const PAGE_MARGINS: [number, number, number, number] = [15, 60, 15, 40];
const PAGE_ORIENTATION: 'landscape' = 'landscape';

/**
 * Cover agency line — HARDCODED per the Phase 2.5 ผ.03 spec
 * (`por03-table.part.ts:93`). Reused verbatim for consistency between
 * the two ผ.03 print surfaces.
 */
const POR03_COVER_AGENCY_LINE = 'กองยุทธศาสตร์และงบประมาณ';

/**
 * Change detector for cell-level emphasis. Mirrors
 * `report-revision-edit-detail.part.ts:10-38` (string trim, number, and
 * budget-array comparison) reduced to the equipment field set.
 */
const hasChanged = (oldValue: any, newValue: any): boolean => {
  if (oldValue === null || oldValue === undefined) {
    return newValue !== null && newValue !== undefined;
  }
  if (newValue === null || newValue === undefined) {
    return true;
  }
  if (typeof oldValue === 'string' && typeof newValue === 'string') {
    return oldValue.trim() !== newValue.trim();
  }
  if (typeof oldValue === 'number' && typeof newValue === 'number') {
    return oldValue !== newValue;
  }
  return String(oldValue) !== String(newValue);
};

/** Per-year budget map keyed by Number(year) → Number(quantity). */
const budgetByYear = (
  row:
    | EquipmentProjectGroup
    | RevisedEquipmentProjectGroup
    | SupplementEquipmentProjectGroup
    | null,
): Map<number, number> => {
  const map = new Map<number, number>();
  if (!row?.budgets) return map;
  for (const b of row.budgets) {
    const year = Number(b.year);
    const qty = Number(b.quantity);
    if (Number.isNaN(year) || Number.isNaN(qty)) continue;
    map.set(year, qty);
  }
  return map;
};

/**
 * Column-width budgeter — mirror of
 * `calculateEquipmentColumnWidths` (`por03-table.part.ts:100-145`) with a
 * leading "รายการ" (เดิม/ใหม่) label column inserted after the index.
 */
const calculateRevisionColumnWidths = (years: number[]): string[] => {
  const baseWidths: Record<string, number> = {
    index: 4,
    // No "รายการ" (เดิม/ใหม่) column — its former 6% is absorbed by the
    // two text columns below so the table still fills the page width.
    equipmentName: 16,
    targetOutput: 18,
    // budget handled separately
    expectedResults: 13,
    responsibleAgency: 9,
  };
  const nonBudgetCols = [
    'index',
    'equipmentName',
    'targetOutput',
    'expectedResults',
    'responsibleAgency',
  ];
  const usedWidth = nonBudgetCols.reduce(
    (sum, c) => sum + (baseWidths[c] ?? 10),
    0,
  );
  const budgetWidth = Math.max(40, 100 - usedWidth);
  const budgetWidthPerYear = years.length
    ? Math.max(6, Math.floor(budgetWidth / years.length))
    : budgetWidth;

  const widths: number[] = [];
  widths.push(baseWidths.index);
  widths.push(baseWidths.equipmentName);
  widths.push(baseWidths.targetOutput);
  for (const _ of years) widths.push(budgetWidthPerYear);
  widths.push(baseWidths.expectedResults);
  widths.push(baseWidths.responsibleAgency);

  const totalWidth = widths.reduce((s, w) => s + w, 0);
  if (Math.abs(totalWidth - 100) > 0.1 && widths.length > 0) {
    const adjustment = (100 - totalWidth) / widths.length;
    return widths.map((w) => `${(w + adjustment).toFixed(2)}%`);
  }
  return widths.map((w) => `${w}%`);
};

export const createPor03RevisionDetailDocDefinition = (
  params: Por03RevisionDetailDocParams,
): TDocumentDefinitions | null => {
  const {
    developmentPlanName,
    groups,
    years,
    newWord,
    includeCoverBlock = true,
  } = params;

  if (groups.length === 0) {
    return null;
  }

  const content: any[] = [];
  const columnWidths = calculateRevisionColumnWidths(years);
  // 1 section-header row + 2 column-header rows = 3 header rows pdfmake
  // repeats on every continuation page (mirror of
  // `por03-table.part.ts:169`).
  const HEADER_ROWS = 3;
  // index + name + target + N years + expected + agency.
  // (No "รายการ" เดิม/ใหม่ label column — mirrors ผ.02 which separates
  //  OLD vs NEW by stacked rows + a reason row, not by a column.)
  const totalColumns = 5 + years.length;

  // ── Top-of-document centered cover block ─────────────────────────
  // Identical to the standard ผ.03 cover (`por03-table.part.ts:232-246`)
  // — the OLD/NEW comparison nature is conveyed by the table body
  // (stacked เดิม/ใหม่ rows + bold-on-change), not by the title.
  // Gated on `includeCoverBlock` so the GROUP-LEVEL render loop (one
  // group per buffer) emits the cover ONLY on the first group's buffer
  // (mirror of `por03-table.part.ts:232`).
  if (includeCoverBlock) {
    content.push({
      text: [
        { text: 'บัญชีครุภัณฑ์\n' },
        'สำหรับที่ไม่ได้จัดทำเป็นโครงการพัฒนาท้องถิ่น\n',
        developmentPlanName + '\n',
        POR03_COVER_AGENCY_LINE + '\n',
      ],
      alignment: 'center',
      margin: [0, 0, 0, 10],
      fontSize: 12,
      bold: true,
      style: 'tableHeader',
    });
  }

  groups.forEach((group, groupIndex) => {
    const tableBody: any[] = [];

    // Row 1 — section header stack (Category / Tactic / Plan). Mirror of
    // `por03-table.part.ts:255-283`.
    tableBody.push([
      {
        colSpan: totalColumns,
        stack: [
          {
            text: `ประเภทครุภัณฑ์: ${group.categoryCode}. ${group.categoryName}`,
            bold: true,
            lineHeight: 1.2,
          },
          {
            text: `กลยุทธ์: ${group.tacticName}`,
            bold: true,
            margin: [20, 0, 0, 0],
            lineHeight: 1.2,
          },
          {
            text: `แผนงาน: ${group.planName}`,
            bold: true,
            margin: [40, 0, 0, 0],
            lineHeight: 1.2,
          },
        ],
        border: [false, false, false, false],
      },
      ...Array.from({ length: totalColumns - 1 }, () => ({
        text: '',
        border: [false, false, false, false],
      })),
    ]);

    // Rows 2-3 — column headers.
    const headerRow1: any[] = [];
    const headerRow2: any[] = [];

    headerRow1.push({
      text: 'ที่',
      rowSpan: 2,
      style: 'tableHeader2',
      alignment: 'center',
      margin: [0, 10, 0, 0],
    });
    headerRow2.push({ text: '', style: 'tableHeader2' });

    headerRow1.push({
      text: 'ครุภัณฑ์',
      rowSpan: 2,
      style: 'tableHeader2',
      alignment: 'center',
      margin: [0, 10, 0, 0],
    });
    headerRow2.push({ text: '', style: 'tableHeader2' });

    headerRow1.push({
      text: 'เป้าหมาย\n(ผลผลิตของครุภัณฑ์)',
      rowSpan: 2,
      style: 'tableHeader2',
      alignment: 'center',
      margin: [0, 3, 0, 0],
    });
    headerRow2.push({ text: '', style: 'tableHeader2' });

    // budget — colSpan over the year axis, then per-year sub-headers.
    headerRow1.push({
      text: 'งบประมาณรายปี',
      colSpan: years.length,
      style: 'tableHeader2',
      alignment: 'center',
    });
    for (let i = 1; i < years.length; i += 1) {
      headerRow1.push({ text: '', style: 'tableHeader' });
    }
    for (const year of years) {
      headerRow2.push({
        text: String(year),
        style: 'tableHeader',
        alignment: 'center',
        margin: [0, 2, 0, 0],
      });
    }

    headerRow1.push({
      text: 'ผลที่คาดว่าจะได้รับ',
      rowSpan: 2,
      style: 'tableHeader2',
      alignment: 'center',
      margin: [0, 10, 0, 0],
    });
    headerRow2.push({ text: '', style: 'tableHeader2' });

    headerRow1.push({
      text: 'หน่วยงาน\nรับผิดชอบ',
      rowSpan: 2,
      style: 'tableHeader2',
      alignment: 'center',
      margin: [0, 6, 0, 0],
    });
    headerRow2.push({ text: '', style: 'tableHeader2' });

    tableBody.push(headerRow1, headerRow2);

    // Data rows — mirror ผ.02 (`report-revision-edit-detail-user.part.ts`):
    // per equipment we emit the OLD (เดิม) baseline row, then a spanned
    // reason row (the revision/change justification — ผ.02's
    // `additionalDetail` analog), then the NEW (ใหม่) row whose CHANGED
    // cells are bold (`hasChanged` against `previous`). There is NO
    // เดิม/ใหม่ label column — the reason row + bold-on-change separate
    // the two, exactly as ผ.02 does.
    // "ที่" (index) RESETS per (Category, Tactic, Plan) group; the same
    // ordinal is shown on the OLD and NEW row of a pair.
    let idx = 1;
    for (const pair of group.pairs) {
      const { current, previous } = pair;
      const prevBudgets = budgetByYear(previous);
      const currBudgets = budgetByYear(current);

      // ── OLD context row (ข้อความเดิม) — spans all columns, bold; the
      //    OLD-side analog of ผ.02's `oldAdditionDetail` line. Mirrors the
      //    NEW-side reason row chrome so the two context lines read as
      //    siblings. Omitted entirely when `previous` is null (no lineage
      //    parent). Option A (minimal): composed from the parent plan name
      //    + `previous.pageNumber` only — no previous-revision label
      //    resolution, keeping this fix renderer-only with zero resolver
      //    changes. The "(หน้า X)" segment is dropped when `pageNumber` is
      //    null (equipment rows often lack it — matches ผ.02's tolerance). ──
      if (previous) {
        const pageSegment =
          previous.pageNumber != null ? ` (หน้า ${previous.pageNumber})` : '';
        const oldContextText = `ข้อความเดิม${pageSegment} ${developmentPlanName}`
          .replace(/\s+/g, ' ')
          .trim();
        tableBody.push([
          {
            colSpan: totalColumns,
            text: newWord(oldContextText),
            font: 'THSarabun',
            bold: true,
            border: [true, false, true, false],
            margin: [5, 2, 5, 2],
          },
          ...Array.from({ length: totalColumns - 1 }, () => ({
            text: '',
            border: [false, false, false, false],
          })),
        ]);
      }

      // ── OLD (เดิม) baseline row — comparison values, normal weight. ──
      const oldRow: any[] = [];
      oldRow.push({ text: String(idx), alignment: 'center' });
      oldRow.push({
        text: newWord(previous?.equipmentName ?? ''),
        font: 'THSarabun',
      });
      oldRow.push({
        text: newWord(previous?.targetOutput ?? ''),
        font: 'THSarabun',
      });
      for (const year of years) {
        const val = prevBudgets.get(year);
        oldRow.push({
          text: val === undefined ? '' : val.toLocaleString('th-TH'),
          alignment: 'right',
        });
      }
      oldRow.push({
        text: newWord(previous?.expectedResults ?? ''),
        font: 'THSarabun',
      });
      oldRow.push({
        text: newWord(previous?.responsibleAgency?.name ?? '-'),
        font: 'THSarabun',
        alignment: 'center',
      });
      tableBody.push(oldRow);

      // ── Reason row (เหตุผลการแก้ไข/เปลี่ยนแปลง) — spans all columns,
      //    bold; the ผ.02 `additionalDetail` analog. Separates the OLD
      //    baseline from the NEW (changed) values. Omitted when blank. ──
      const reasonText = (current.reason ?? '').trim();
      if (reasonText) {
        tableBody.push([
          {
            colSpan: totalColumns,
            text: newWord(reasonText),
            font: 'THSarabun',
            bold: true,
            border: [true, false, true, false],
            margin: [5, 2, 5, 2],
          },
          ...Array.from({ length: totalColumns - 1 }, () => ({
            text: '',
            border: [false, false, false, false],
          })),
        ]);
      }

      // ── NEW (ใหม่) row — CHANGED cells bold (`hasChanged`). ──
      const newRow: any[] = [];
      newRow.push({ text: String(idx), alignment: 'center' });
      newRow.push({
        text: newWord(current.equipmentName ?? ''),
        font: 'THSarabun',
        bold: hasChanged(previous?.equipmentName, current.equipmentName),
      });
      newRow.push({
        text: newWord(current.targetOutput ?? ''),
        font: 'THSarabun',
        bold: hasChanged(previous?.targetOutput, current.targetOutput),
      });
      for (const year of years) {
        const val = currBudgets.get(year);
        const changed = prevBudgets.get(year) !== val;
        newRow.push({
          text: val === undefined ? '' : val.toLocaleString('th-TH'),
          alignment: 'right',
          bold: changed,
        });
      }
      newRow.push({
        text: newWord(current.expectedResults ?? ''),
        font: 'THSarabun',
        bold: hasChanged(previous?.expectedResults, current.expectedResults),
      });
      newRow.push({
        text: newWord(current.responsibleAgency?.name ?? '-'),
        font: 'THSarabun',
        alignment: 'center',
        bold: hasChanged(
          previous?.responsibleAgency?.name,
          current.responsibleAgency?.name,
        ),
      });
      tableBody.push(newRow);

      idx += 1;
    }

    const tableContent: any = {
      table: { headerRows: HEADER_ROWS, widths: columnWidths, body: tableBody },
      layout: {
        hLineWidth: (i: number, node: any) => {
          if (i === 0) return 0;
          if (node.table.body[i]?.[0]?.stack) return 0;
          return 0.3;
        },
        vLineWidth: () => 0.3,
        hLineColor: () => '#000',
        vLineColor: () => '#000',
        paddingTop: (i: number, node: any) =>
          node.table.body[i]?.[0]?.stack ? 0 : 2,
        paddingBottom: (i: number, node: any) =>
          node.table.body[i]?.[0]?.stack ? 0 : 2,
      },
      pageBreak: groupIndex > 0 ? 'before' : undefined,
    };

    content.push(tableContent);
  });

  return {
    // Top-right "แบบ ผ.03" stamp on EVERY page (verbatim from
    // `por03-table.part.ts:442-449`).
    header: function () {
      return {
        text: 'แบบ ผ.03',
        alignment: 'right',
        fontSize: 11,
        margin: [0, 40, 20, 0],
      };
    },
    // Phase (2026-06-04) — when `pageOffset` is set (assembly merge/preview
    // append), render the ผ.02-style footer (centered plan name +
    // right-aligned continuous page number) so the ผ.03 revision pages
    // continue the merged-book page sequence (§21.3 parity). When omitted
    // (Phase 2.5 print / Phase 2.6 staff-draft surfaces) the footer stays
    // null per the locked decision (README §12 / §5.3 Phase 2.5). Mirror
    // of `por03-table.part.ts:455-483`.
    footer:
      typeof params.pageOffset === 'number'
        ? function (currentPage: number) {
            const footerText = params.newWord
              ? params.newWord(params.developmentPlanName)
              : params.developmentPlanName;
            const pageNumber = currentPage + (params.pageOffset ?? 0);
            return {
              columns: [
                { text: '', width: '*' },
                {
                  text: footerText,
                  alignment: 'center',
                  width: 'auto',
                  fontSize: 12,
                  bold: true,
                },
                {
                  text: String(pageNumber),
                  alignment: 'right',
                  width: '*',
                  margin: [0, 0, 20, 0],
                  fontSize: 12,
                  bold: true,
                },
              ],
              margin: [15, 0, 15, 20],
            };
          }
        : function () {
            return null;
          },
    content,
    pageSize: 'A4',
    pageOrientation: PAGE_ORIENTATION,
    pageMargins: PAGE_MARGINS,
    defaultStyle: { font: 'THSarabun', fontSize: 10 },
    styles: {
      tableHeader: { alignment: 'center', bold: true, fontSize: 11 },
      tableHeader2: { alignment: 'center', bold: true, fontSize: 10 },
    },
  };
};
