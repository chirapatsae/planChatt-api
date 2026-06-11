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
  /**
   * Phase 3 (2026-05-31) — when set, the footer renders a continuous
   * page number = `currentPage + pageOffset` in the SAME style as the
   * ผ.02 detail part (`report-project-detail.part.ts:72-99`) so ผ.03
   * pages continue the ผ.02 sequence with a visually identical footer.
   * When undefined, the footer stays null (Phase 2.5/2.6 print surfaces).
   */
  pageOffset?: number;
  /**
   * When `false`, the top-of-document centered 4-line cover block is
   * OMITTED. Used by the group-level page-tracking render path
   * (Wave Equipment Phase 3 BE-04), where the cover block is emitted
   * ONCE on the first group's buffer and suppressed on every
   * subsequent group's buffer so the cover does not repeat per page.
   * Defaults to `true` — the single-document render path (owner print
   * + draft append) keeps the cover on the first page as before.
   */
  includeCoverBlock?: boolean;
  /**
   * Owner print surface (2026-06-10) — when set AND `pageOffset` is
   * undefined, every page renders a centered footer carrying this text
   * (main plan + supplement round label, e.g. "แผนพัฒนาท้องถิ่น พ.ศ.
   * 2566-2570 · ฉบับเพิ่มเติม ครั้งที่ 1"). NO page number is added,
   * preserving the ผ.03 print no-page-numbers rule (README §12); only
   * the book label is shown. Ignored when `pageOffset` is a number (the
   * continuous-pagination append path owns the footer there).
   */
  footerCenterText?: string;
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
  // 1 section-header row + 2 column-header rows = 3 header rows that
  // pdfmake repeats on every continuation page. Mirrors the
  // STRATEGY_BASED main-plan renderer's `headerRows: 3` (verbatim from
  // `report-project-detail.part.ts:419`). Continuation tables (none
  // emitted today since each group is one table) would use 2.
  const HEADER_ROWS = 3;
  const totalColumns = 5 + years.length; // index + name + target + N years + expected + agency

  // Per-group summary rows (2026-05-30) — mirror ผ.02's "รวมงบประมาณ" +
  // count rows (`report-project-detail.part.ts:354-406`). Two rows:
  //   1. รวมงบประมาณ          — sum of budget per fiscal year
  //   2. รวมจำนวนครุภัณฑ์      — count of items with budget per year
  // Layout: label spans the 3 left columns (index/name/target); the
  // trailing 2 columns (expected/agency) span an empty cell. Cell count
  // = 3 + years.length + 2 = totalColumns.
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
  // Emitted ONCE before the first group's table. Mirrors ผ.02's
  // "รายละเอียดโครงการ" centered cover block at
  // `report-project-detail.part.ts:565-577`. The four ผ.03 lines per
  // the user's 2026-05-28 directive:
  //   1. บัญชีครุภัณฑ์
  //   2. สำหรับที่ไม่ได้จัดทำเป็นโครงการพัฒนาท้องถิ่น
  //   3. {developmentPlanName}  — already includes "พ.ศ. {start-end}"
  //   4. กองยุทธศาสตร์และงบประมาณ  — hardcoded per spec
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

      tableBody.push(rowData);
    }

    // Per-group summary — รวมงบประมาณ (per year) + รวมจำนวนครุภัณฑ์.
    for (const summaryRow of buildSummaryRows(group.rows)) {
      tableBody.push(summaryRow);
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
    // Phase 3 — when `pageOffset` is set, render the ผ.02-style footer
    // (centered plan name + right-aligned continuous page number) so
    // ผ.03 pages continue the ผ.02 sequence visually-identically. When
    // omitted (Phase 2.5/2.6 print surfaces) the footer stays null per
    // the locked decision in README §12.
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
      : params.footerCenterText
        ? function () {
            const footerText = params.newWord
              ? params.newWord(params.footerCenterText as string)
              : (params.footerCenterText as string);
            return {
              text: footerText,
              alignment: 'center',
              fontSize: 12,
              bold: true,
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

/**
 * Full-page ผ.03 SECTION DIVIDER (wave-staff-draftbook-por03-append,
 * 2026-05-30).
 *
 * Renders a single landscape A4 page carrying ONLY a large vertically-
 * centered title "บัญชีครุภัณฑ์ (ผ.03)". Mirrors the ผ.02 strategy
 * divider page (`createGroupCoverPageDocDefinition` at
 * `report-project-detail.part.ts:55-114`, 48pt bold centered title)
 * so the combined staff draft book gets a clean visual break between
 * the ผ.02 project section and the appended ผ.03 equipment section —
 * exactly like the per-strategy divider pages inside ผ.02.
 *
 * Scope: PREPENDED only on the STAFF plan-wide draft-book path
 * (`Por03PdfService.renderPlanScopedPor03Buffer`). The owner-side
 * `/project/print-equipment` (`generate()` → `buildPor03Buffer`) is
 * UNTOUCHED — it keeps its inline 4-line cover block and gets no
 * full-page divider.
 *
 * Style notes:
 *   - Top-right "แบบ ผ.03" stamp matches every ผ.03 detail page
 *     (header function identical to `createPor03DetailDocDefinition`).
 *   - NO page numbers (footer returns null) — consistent with the
 *     ผ.03 no-page-numbers rule (README §12 / §5.3 Phase 2.5).
 *   - Landscape A4 + same page margins as the ผ.03 detail doc so the
 *     merged section is dimensionally homogeneous.
 */
export const createPor03SectionDividerDocDefinition =
  (): TDocumentDefinitions => {
    // Landscape A4 inner height = 595 - top(60) - bottom(40) = 495.
    // Center the 36pt title vertically (mirror of the ผ.02 divider's
    // `availablePageHeight / 2 - fontSize / 2` math).
    const pageHeight = 595;
    const availablePageHeight = pageHeight - PAGE_MARGINS[1] - PAGE_MARGINS[3];
    const titleFontSize = 36;
    const titleTopMargin = Math.max(
      0,
      availablePageHeight / 2 - titleFontSize / 2,
    );

    return {
      header: function () {
        return {
          text: 'แบบ ผ.03',
          alignment: 'right',
          fontSize: 11,
          margin: [0, 40, 20, 0],
        };
      },
      footer: function () {
        return null;
      },
      content: [
        {
          text: 'บัญชีครุภัณฑ์ (ผ.03)',
          fontSize: titleFontSize,
          bold: true,
          alignment: 'center',
          margin: [0, titleTopMargin, 0, 0],
        },
      ],
      pageSize: 'A4',
      pageOrientation: PAGE_ORIENTATION,
      pageMargins: PAGE_MARGINS,
      defaultStyle: { font: 'THSarabun', fontSize: 10 },
    };
  };
