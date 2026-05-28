import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';

/**
 * Wave Print ผ.03 — BE-01 (2026-05-28).
 * Refactor 2026-05-28 — REMOVED standalone cover page. The 4 cover
 * lines now appear CENTERED at the top of the first detail page
 * (ONCE for the entire document), mirroring ผ.02's
 * "รายละเอียดโครงการ" centered top block at
 * `report-project-detail.part.ts:565-577`. The Category / Tactic /
 * Plan stack is embedded as the FIRST ROW of each group's table
 * body — mirror of ผ.02's STP stack at
 * `report-project-detail.part.ts:196-209`. `headerRows = 3` on the
 * first table of a group (stack row + 2 column-header rows) so
 * pdfmake pins the section header on continuation pages.
 *
 * Column set per README §9:
 *   ที่ | ครุภัณฑ์ | เป้าหมาย (ผลผลิตของครุภัณฑ์) |
 *     งบประมาณรายปี (one sub-column per fiscal year) |
 *     ผลที่คาดว่าจะได้รับ | หน่วยงานรับผิดชอบ
 *
 * The "ก-จ" external-alignment block from ผ.02 is intentionally
 * OMITTED — equipment does not have an external-alignment axis
 * (verbatim per the user's 2026-05-28 directive).
 *
 * Top-right "แบบ ผ.03" stamp on every page (header function) and NO
 * page numbers (footer returns `null`) per README §12.
 *
 * NOTE — the per-group table is currently a SINGLE table per group
 * (no in-group splits — equipment has no `originAgency` axis to split
 * on). This keeps the loop simpler than ผ.02's continuation-table
 * machinery while preserving the same `headerRows` repeat semantic
 * for any long table that wraps to multiple pages.
 */

export interface EquipmentTableGroup {
  /**
   * Category / Tactic / Plan that owns the rows below. `categoryCode`
   * appears in the section header as "ประเภทครุภัณฑ์ ผ.03-{code}".
   * `tacticName` and `planName` map to "กลยุทธ์ {name}" and
   * "แผนงาน {name}" respectively.
   */
  categoryCode: number;
  categoryName: string;
  tacticName: string;
  planName: string;
  rows: EquipmentProjectGroup[];
}

export interface Por03DetailDocParams {
  /**
   * Parent `DevelopmentPlan.name` — rendered as one of the four
   * centered cover lines at the top of the first detail page. The
   * service is responsible for resolving this from the parent plan
   * row; the renderer treats it as opaque text. Per the user spec
   * the plan name already encodes the "พ.ศ. {start-end}" window
   * (e.g., "แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570").
   */
  developmentPlanName: string;
  groups: EquipmentTableGroup[];
  years: number[];
  newWord: (text: string) => any;
}

const PAGE_MARGINS: [number, number, number, number] = [15, 60, 15, 40];
const PAGE_ORIENTATION: 'landscape' = 'landscape';

/**
 * The agency line on the ผ.03 cover block is HARDCODED per user
 * spec (2026-05-28). ผ.02 renders "องค์การบริหารส่วนจังหวัด-
 * นครราชสีมา" on its cover block; ผ.03 renders the originating
 * division ("กองยุทธศาสตร์และงบประมาณ") because the report is owned
 * by that division, not the parent อบจ unit.
 */
const POR03_COVER_AGENCY_LINE = 'กองยุทธศาสตร์และงบประมาณ';

/**
 * Column-width budgeter — mirrors the percentage logic in
 * `report-project-detail.part.ts:10-52` (`calculateColumnWidths`) but
 * with the equipment-specific column-id set.
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

export const createPor03DetailDocDefinition = (
  params: Por03DetailDocParams,
): TDocumentDefinitions | null => {
  const { developmentPlanName, groups, years, newWord } = params;

  if (groups.length === 0) {
    return null;
  }

  const content: any[] = [];
  const columnWidths = calculateEquipmentColumnWidths(years);
  // 1 section-header row + 2 column-header rows = 3 header rows that
  // pdfmake repeats on every continuation page. Mirrors the
  // STRATEGY_BASED main-plan renderer's `headerRows: 3` (verbatim from
  // `report-project-detail.part.ts:419`). Continuation tables (none
  // emitted today since each group is one table) would use 2.
  const HEADER_ROWS = 3;
  const totalColumns = 5 + years.length; // index + name + target + N years + expected + agency

  // ── Top-of-document centered cover block ─────────────────────────
  // Emitted ONCE before the first group's table. Mirrors ผ.02's
  // "รายละเอียดโครงการ" centered cover block at
  // `report-project-detail.part.ts:565-577`. The four ผ.03 lines per
  // the user's 2026-05-28 directive:
  //   1. บัญชีครุภัณฑ์
  //   2. สำหรับที่ไม่ได้จัดทำเป็นโครงการพัฒนาท้องถิ่น
  //   3. {developmentPlanName}  — already includes "พ.ศ. {start-end}"
  //   4. กองยุทธศาสตร์และงบประมาณ  — hardcoded per spec
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

  groups.forEach((group, groupIndex) => {
    const tableBody: any[] = [];

    // Row 1 — section header stack (Category / Tactic / Plan).
    // Mirror of ผ.02 STP stack at
    // `report-project-detail.part.ts:196-209`. Bold + cascading left
    // margin (0 / 20 / 40) for visual hierarchy.
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

    tableBody.push(headerRow1, headerRow2);

    // Data rows — sequential "ที่" RESETS per (Category, Tactic, Plan)
    // group per README §9 (column 1 spec: "1-based within group").
    let idx = 1;
    for (const row of group.rows) {
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

      // Budget columns — one per fiscal year in the parent-plan window.
      // README §10: blank cell for years with no budget row; explicit
      // `0` is rendered as `"0"` to distinguish zero-quantity from
      // no-row. Currency formatting matches the ผ.02 renderer at
      // `report-project-detail.part.ts:266` (`th-TH` locale,
      // thousand-separated).
      for (const year of years) {
        const match = row.budgets?.find((b) => b.year === year);
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

      tableBody.push(rowData);
    }

    const tableContent: any = {
      table: { headerRows: HEADER_ROWS, widths: columnWidths, body: tableBody },
      layout: {
        hLineWidth: (i: number, node: any) => {
          // Strip the section-header row's horizontal border (mirrors
          // `report-project-detail.part.ts:424-428`).
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
      // First group renders on the SAME page as the centered cover
      // block (no pageBreak). Subsequent groups break to a fresh page
      // so each group's section header is anchored at the top of its
      // own page.
      pageBreak: groupIndex > 0 ? 'before' : undefined,
    };

    content.push(tableContent);
  });

  return {
    // Top-right "แบบ ผ.03" stamp on EVERY page. Pattern verbatim from
    // `report-project-detail.part.ts:612`, literal swapped to ผ.03.
    header: function () {
      return {
        text: 'แบบ ผ.03',
        alignment: 'right',
        fontSize: 11,
        margin: [0, 40, 20, 0],
      };
    },
    // NO page numbers per locked decision in README §12.
    footer: function () {
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
