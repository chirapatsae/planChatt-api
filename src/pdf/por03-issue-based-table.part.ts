import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';

/**
 * Wave Equipment Phase 3 — BE-03 (2026-05-30).
 *
 * ISSUE_BASED ผ.03 (equipment) detail layout — the sibling of the
 * STRATEGY_BASED layout in `por03-table.part.ts`. User direction
 * 2026-05-30: "ผ.03 อยู่ทั้งสองแบบเลย" — equipment now renders under
 * BOTH plan formats (§16.5 dual-shape).
 *
 * Differences from `por03-table.part.ts` (STRATEGY_BASED):
 *   - Grouping is `DevelopmentIssue` (outer) → `EquipmentCategory`
 *     (inner). The strategy layout groups Category → Tactic → Plan.
 *   - The per-issue section divider is a SINGLE line
 *     `ประเด็นการพัฒนา: {issueName}` mirroring the ผ.02 ISSUE_BASED
 *     renderer (`report-project-detail-issue-based.part.ts:195-208`) so
 *     ผ.02 and ผ.03 read consistently inside one assembled book. Within
 *     each issue, every category gets a `ประเภทครุภัณฑ์: {code}. {name}`
 *     sub-header (kept from the strategy layout's category line).
 *   - strategy / tactic / plan are NEVER referenced (§16.5 ISSUE_BASED
 *     shape: those FKs are NULL).
 *
 * IDENTICAL to the STRATEGY_BASED layout:
 *   - Column set: ที่ | ครุภัณฑ์ | เป้าหมาย | งบประมาณรายปี (per-year
 *     sub-columns) | ผลที่คาดว่าจะได้รับ | หน่วยงานรับผิดชอบ. Equipment
 *     has NO KPI/indicator column in either shape (§16.5).
 *   - Per-group summary rows (รวมงบประมาณ / รวมจำนวนครุภัณฑ์).
 *   - Centered 4-line cover block once at the top of the first page.
 *   - Top-right "แบบ ผ.03" stamp on every page; NULL footer (NO page
 *     numbers — the formal assembly's global post-merge pass numbers the
 *     whole book, owned by BE-01).
 *   - Landscape A4 + page margins [15, 60, 15, 40].
 *
 * `createPor03SectionDividerDocDefinition` ("บัญชีครุภัณฑ์ (ผ.03)"
 * full-page divider) is format-agnostic — REUSE it from
 * `por03-table.part.ts`; this file deliberately does NOT redefine it.
 */

const PAGE_MARGINS: [number, number, number, number] = [15, 60, 15, 40];
const PAGE_ORIENTATION: 'landscape' = 'landscape';

/**
 * The agency line on the ผ.03 cover block is HARDCODED per user spec
 * (2026-05-28) — keep in sync with `por03-table.part.ts`
 * (`POR03_COVER_AGENCY_LINE`).
 */
const POR03_COVER_AGENCY_LINE = 'กองยุทธศาสตร์และงบประมาณ';

/**
 * Column-width budgeter.
 *
 * keep in sync with `por03-table.part.ts` (`calculateEquipmentColumnWidths`).
 * Copied verbatim because the column set is IDENTICAL (equipment has no
 * KPI column in either shape) and the strategy file's helper is a
 * module-private const, not exported. If either copy changes, change
 * both byte-for-behavior.
 */
const calculateEquipmentColumnWidths = (years: number[]): string[] => {
  const baseWidths: Record<string, number> = {
    index: 5,
    equipmentName: 14,
    targetOutput: 16,
    // budget handled separately
    expectedResults: 14,
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
  // index
  widths.push(baseWidths.index);
  // equipmentName
  widths.push(baseWidths.equipmentName);
  // targetOutput
  widths.push(baseWidths.targetOutput);
  // budget per year
  for (const _ of years) widths.push(budgetWidthPerYear);
  // expectedResults
  widths.push(baseWidths.expectedResults);
  // responsibleAgency
  widths.push(baseWidths.responsibleAgency);

  const totalWidth = widths.reduce((s, w) => s + w, 0);
  if (Math.abs(totalWidth - 100) > 0.1 && widths.length > 0) {
    const adjustment = (100 - totalWidth) / widths.length;
    return widths.map((w) => `${(w + adjustment).toFixed(2)}%`);
  }
  return widths.map((w) => `${w}%`);
};

/**
 * One category block within an issue. `categoryCode` / `categoryName`
 * render the `ประเภทครุภัณฑ์: {code}. {name}` sub-header. NO
 * tactic/plan/strategy fields — those are NULL for ISSUE_BASED rows.
 */
export interface EquipmentIssueCategoryGroup {
  categoryCode: number;
  categoryName: string;
  rows: EquipmentProjectGroup[];
}

/**
 * One development-issue group — outer grouping for the ISSUE_BASED
 * ผ.03 layout. Renders a single-line `ประเด็นการพัฒนา: {issueName}`
 * divider, then one `categories[]` block per equipment category.
 */
export interface EquipmentIssueTableGroup {
  issueName: string;
  /** Optional issue sort key; the builder sorts groups by this then name. */
  issueSortOrder?: number;
  categories: EquipmentIssueCategoryGroup[];
}

export interface Por03IssueBasedDetailDocParams {
  /**
   * Parent `DevelopmentPlan.name` — rendered as one of the four
   * centered cover lines at the top of the first detail page. Treated
   * as opaque text; per spec it already encodes "พ.ศ. {start-end}".
   */
  developmentPlanName: string;
  groups: EquipmentIssueTableGroup[];
  years: number[];
  newWord: (text: string) => any;
  /**
   * When `false`, the top-of-document centered 4-line cover block is
   * OMITTED. Used by the group-level page-tracking render path
   * (Wave Equipment Phase 3 BE-04) so the cover block is emitted ONCE
   * on the first issue group's buffer and suppressed on every
   * subsequent issue group's buffer. Defaults to `true`.
   */
  includeCoverBlock?: boolean;
  /**
   * Phase 3 — continuous page-number offset (sum of ผ.01/ผ.02 page
   * counts). When set, the footer renders `currentPage + pageOffset`
   * in the same style as the ผ.02 detail part so ผ.03 pages visually
   * continue the ผ.02 sequence. When undefined, the footer stays null.
   */
  pageOffset?: number;
}

export const createPor03IssueBasedDetailDocDefinition = (
  params: Por03IssueBasedDetailDocParams,
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
  const columnWidths = calculateEquipmentColumnWidths(years);
  // 1 issue-divider row + 1 category sub-header row + 2 column-header
  // rows = 4 header rows pinned on continuation pages. (The strategy
  // layout uses 3 because its section header is a SINGLE stacked row;
  // the issue layout has TWO header rows — the issue line and the
  // category line — so HEADER_ROWS = 4.)
  const HEADER_ROWS = 4;
  const totalColumns = 5 + years.length; // index + name + target + N years + expected + agency

  // Per-category summary rows — mirror `por03-table.part.ts`
  // (`buildSummaryRows`). keep in sync byte-for-behavior.
  const buildSummaryRows = (rows: EquipmentProjectGroup[]): any[][] => {
    const sumByYear: Record<number, number> = Object.fromEntries(
      years.map((y) => [y, 0]),
    );
    const countByYear: Record<number, number> = Object.fromEntries(
      years.map((y) => [y, 0]),
    );
    for (const r of rows) {
      for (const year of years) {
        const match = r.budgets?.find((b) => Number(b.year) === year);
        if (!match) continue;
        const val = Number(match.quantity);
        if (Number.isNaN(val)) continue;
        sumByYear[year] += val;
        countByYear[year] += 1;
      }
    }
    const budgetRow: any[] = [
      { text: 'รวมงบประมาณ', colSpan: 3, alignment: 'center', bold: true },
      {},
      {},
      ...years.map((y) => ({
        text: sumByYear[y] ? sumByYear[y].toLocaleString('th-TH') : '',
        alignment: 'right',
        bold: true,
      })),
      { text: '', colSpan: 2 },
      {},
    ];
    const countRow: any[] = [
      { text: 'รวมจำนวนครุภัณฑ์', colSpan: 3, alignment: 'center', bold: true },
      {},
      {},
      ...years.map((y) => ({
        text: countByYear[y] ? String(countByYear[y]) : '',
        alignment: 'center',
        bold: true,
      })),
      { text: '', colSpan: 2 },
      {},
    ];
    return [budgetRow, countRow];
  };

  // ── Top-of-document centered cover block ─────────────────────────
  // Emitted ONCE before the first group's table. Identical to the
  // STRATEGY_BASED ผ.03 cover at `por03-table.part.ts:208-220`.
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

  // Build the column-header rows (2 rows) for a category table. Shared
  // by every category block — identical to the STRATEGY_BASED column
  // headers at `por03-table.part.ts:259-327`.
  const buildColumnHeaderRows = (): [any[], any[]] => {
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

    // budget — colSpan over the year axis, then per-year sub-headers
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

    return [headerRow1, headerRow2];
  };

  // Build the data + summary rows for one category. "ที่" RESETS per
  // category block (mirror of the strategy layout's per-group reset).
  const buildDataRows = (rows: EquipmentProjectGroup[]): any[][] => {
    const out: any[][] = [];
    let idx = 1;
    for (const row of rows) {
      const rowData: any[] = [];
      rowData.push({ text: String(idx++), alignment: 'center' });
      rowData.push({
        text: newWord(row.equipmentName ?? ''),
        font: 'THSarabun',
      });
      rowData.push({
        text: newWord(row.targetOutput ?? ''),
        font: 'THSarabun',
      });

      for (const year of years) {
        const match = row.budgets?.find((b) => Number(b.year) === year);
        if (!match) {
          rowData.push({ text: '', alignment: 'right' });
        } else {
          const value = Number(match.quantity);
          if (Number.isNaN(value)) {
            rowData.push({ text: '', alignment: 'right' });
          } else {
            rowData.push({
              text: value.toLocaleString('th-TH'),
              alignment: 'right',
            });
          }
        }
      }

      rowData.push({
        text: newWord(row.expectedResults ?? ''),
        font: 'THSarabun',
      });
      rowData.push({
        text: newWord(row.responsibleAgency?.name ?? '-'),
        font: 'THSarabun',
        alignment: 'center',
      });

      out.push(rowData);
    }
    return out;
  };

  groups.forEach((issueGroup, groupIndex) => {
    issueGroup.categories.forEach((category, categoryIndex) => {
      const tableBody: any[] = [];

      // Row 1 — issue divider on the FIRST category of the issue; on
      // subsequent categories the issue line is omitted (the issue is
      // already established on the page), so the table starts with the
      // category sub-header. We keep a fixed HEADER_ROWS = 4, so when
      // the issue line is omitted we render a zero-height empty divider
      // row to preserve the repeated-header row count.
      const isFirstCategoryOfIssue = categoryIndex === 0;
      tableBody.push([
        {
          colSpan: totalColumns,
          text: isFirstCategoryOfIssue
            ? `ประเด็นการพัฒนา: ${issueGroup.issueName}`
            : '',
          bold: true,
          border: [false, false, false, false],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({
          text: '',
          border: [false, false, false, false],
        })),
      ]);

      // Row 2 — category sub-header `ประเภทครุภัณฑ์: {code}. {name}`.
      tableBody.push([
        {
          colSpan: totalColumns,
          text: `ประเภทครุภัณฑ์: ${category.categoryCode}. ${category.categoryName}`,
          bold: true,
          margin: [20, 0, 0, 0],
          border: [false, false, false, false],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({
          text: '',
          border: [false, false, false, false],
        })),
      ]);

      // Rows 3-4 — column headers.
      const [headerRow1, headerRow2] = buildColumnHeaderRows();
      tableBody.push(headerRow1, headerRow2);

      // Data rows.
      for (const dataRow of buildDataRows(category.rows)) {
        tableBody.push(dataRow);
      }

      // Per-category summary — รวมงบประมาณ + รวมจำนวนครุภัณฑ์.
      for (const summaryRow of buildSummaryRows(category.rows)) {
        tableBody.push(summaryRow);
      }

      const tableContent: any = {
        table: {
          headerRows: HEADER_ROWS,
          widths: columnWidths,
          body: tableBody,
        },
        layout: {
          hLineWidth: (i: number, node: any) => {
            // Strip the divider rows' horizontal border (issue + category
            // header rows carry a borderless stack/text cell).
            if (i === 0) return 0;
            if (
              node.table.body[i]?.[0]?.border &&
              node.table.body[i][0].border[0] === false &&
              node.table.body[i][0].border[1] === false
            ) {
              return 0;
            }
            return 0.3;
          },
          vLineWidth: () => 0.3,
          hLineColor: () => '#000',
          vLineColor: () => '#000',
          paddingTop: (i: number, node: any) =>
            node.table.body[i]?.[0]?.border?.[0] === false ? 0 : 2,
          paddingBottom: (i: number, node: any) =>
            node.table.body[i]?.[0]?.border?.[0] === false ? 0 : 2,
        },
        // First issue group's first category shares the cover-block
        // page (no pageBreak). The first category of every SUBSEQUENT
        // issue breaks to a fresh page so each issue's divider anchors
        // the top of its own page. Within an issue, additional category
        // blocks flow continuously (no pageBreak).
        pageBreak:
          groupIndex > 0 && categoryIndex === 0 ? 'before' : undefined,
      };

      content.push(tableContent);
    });
  });

  return {
    // Top-right "แบบ ผ.03" stamp on EVERY page — identical to
    // `por03-table.part.ts`.
    header: function () {
      return {
        text: 'แบบ ผ.03',
        alignment: 'right',
        fontSize: 11,
        margin: [0, 40, 20, 0],
      };
    },
    // Phase 3 — when `pageOffset` set, render ผ.02-style footer to
    // continue the project sequence. Else null (Phase 2.5/2.6).
    footer: typeof params.pageOffset === 'number'
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
      : function () { return null; },
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
