/**
 * SUPP_PRINT_BE_02 — STRATEGY_BASED supplement detail renderer.
 *
 * Mirrors `report-revision-edit-detail.part.ts` STRATEGY_BASED detail
 * adapted for `SupplementProjectGroup`:
 *   - No previous-version comparison (supplement is additive).
 *   - Groups by Strategy → Tactic → Plan (§16.5 STRATEGY_BASED shape).
 *   - KPI / `indicator` column rendered per Q4=A spec.
 *   - Attachment filename list rendered as a muted-gray single-line
 *     beneath each project (Q7=B).
 *
 * The renderer is shape-strict (§16.5). A row whose classification triple
 * is missing (no `strategy` / `tactic` / `plan`) is a data bug — the caller
 * MUST surface PROJECT_CLASSIFICATION_SHAPE_MISMATCH. To stay defensive at
 * the renderer boundary, a missing classification field falls back to '-'
 * and grouping uses '-' as the group key. We do not throw here so that the
 * page-number assignment (BE_01) and renderer dispatch remain decoupled.
 *
 * This file only renders the per-strategy group cover sheets + the per-project
 * detail tables. There is no supplement-wide cover page — the summary page
 * leads the document, mirroring revision-edit.
 */

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { SupplementDetailDocParams } from './report.types';
// BE-SUPP-01 — four-row external alignment block (NS / MS / SDG / PS)
// injected between the Strategy/Tactic/Plan stack and the column
// headers. STRATEGY_BASED supplement only; ISSUE_BASED renderer is
// untouched.
import type { AlignmentRow } from 'src/project-alignment-mapping/types/alignment.types';
import { buildExternalAlignmentRows } from './report-external-alignment.part';

const calculateColumnWidths = (selectedCols: string[], years: number[]): string[] => {
  if (selectedCols.length === 0) {
    return [];
  }

  const widths: number[] = [];
  const baseWidths: Record<string, number> = {
    index: 5,
    title: 12,
    objective: 12,
    target: 16,
    kpi: 12,
    expectedResult: 12,
    mainAgency: 8,
    amphoe: 7,
    coordinates: 8,
  };

  const nonBudgetColumns = selectedCols.filter(col => col !== 'budget');
  const usedWidth = nonBudgetColumns.reduce((sum, col) => sum + (baseWidths[col] ?? 10), 0);
  const budgetWidth = selectedCols.includes('budget')
    ? Math.max(45, 100 - usedWidth)
    : 0;

  selectedCols.forEach(col => {
    if (col === 'budget') {
      const budgetWidthPerYear = years.length ? Math.max(6, Math.floor(budgetWidth / years.length)) : budgetWidth;
      years.forEach(() => widths.push(budgetWidthPerYear));
    } else {
      const baseWidth = baseWidths[col] ?? 10;
      const adjustedWidth = nonBudgetColumns.length <= 3 ? baseWidth * 1.5 : baseWidth;
      widths.push(adjustedWidth);
    }
  });

  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  if (Math.abs(totalWidth - 100) > 0.1 && widths.length > 0) {
    const adjustment = (100 - totalWidth) / widths.length;
    return widths.map(width => `${(width + adjustment).toFixed(2)}%`);
  }

  return widths.map(width => `${width}%`);
};

const formatCoordinates = (project: any): string => {
  const startLat = project.startLat != null ? Number(project.startLat) : null;
  const startLng = project.startLng != null ? Number(project.startLng) : null;
  const endLat = project.endLat != null ? Number(project.endLat) : null;
  const endLng = project.endLng != null ? Number(project.endLng) : null;

  if (startLat == null || isNaN(startLat) || startLng == null || isNaN(startLng)) {
    return '-';
  }

  const startLatFmt = startLat >= 0 ? `N ${startLat.toFixed(6)}°` : `S ${Math.abs(startLat).toFixed(6)}°`;
  const startLngFmt = startLng >= 0 ? `E ${startLng.toFixed(6)}°` : `W ${Math.abs(startLng).toFixed(6)}°`;

  if (endLat != null && !isNaN(endLat) && endLng != null && !isNaN(endLng)) {
    const endLatFmt = endLat >= 0 ? `N ${endLat.toFixed(6)}°` : `S ${Math.abs(endLat).toFixed(6)}°`;
    const endLngFmt = endLng >= 0 ? `E ${endLng.toFixed(6)}°` : `W ${Math.abs(endLng).toFixed(6)}°`;
    return `จุดเริ่มต้น\n${startLatFmt}\n${startLngFmt}\n\nจุดสิ้นสุด\n${endLatFmt}\n${endLngFmt}`;
  }

  return `จุดเริ่มต้น\n${startLatFmt}\n${startLngFmt}`;
};

const resolveAmphoeName = (project: any): string => {
  const hasOrigin = project.originAgencyId || project.originAgency;
  if (!hasOrigin) return '-';
  return project.originAgencyId?.amphoe?.name
    || project.originAgency?.amphoe?.name
    || project.amphoe?.name
    || '-';
};

const projectHasOriginAgency = (project: any): boolean => {
  const hasIdRef =
    project.originAgencyId &&
    typeof project.originAgencyId === 'object' &&
    project.originAgencyId !== null &&
    (project.originAgencyId.id || project.originAgencyId.name);
  const hasObjRef =
    project.originAgency &&
    typeof project.originAgency === 'object' &&
    project.originAgency !== null &&
    (project.originAgency.id || project.originAgency.name);
  return !!(hasIdRef || hasObjRef);
};

/**
 * Per-group cover page (strategy header). Lightweight intra-document cover
 * that prefixes each strategy block.
 */
export const createSupplementGroupCoverPageDocDefinition = (
  strategyName: string,
  developmentPlanSupplementName: string,
  pageMargins: [number, number, number, number],
  pageOrientation: 'portrait' | 'landscape',
  newWord?: (text: string) => any,
  pageOffset: number = 0,
): TDocumentDefinitions => {
  const pageSize =
    pageOrientation === 'landscape' ? { width: 842, height: 595 } : { width: 595, height: 842 };
  const availablePageHeight = pageSize.height - pageMargins[1] - pageMargins[3];
  const coverTitleFontSize = 48;
  const coverTitleTopMargin = Math.max(0, availablePageHeight / 2 - coverTitleFontSize / 2);

  return {
    header: function () {
      return null;
    },
    footer: function (currentPage: number) {
      const footerText = newWord
        ? newWord(developmentPlanSupplementName)
        : developmentPlanSupplementName;
      const pageNumber = currentPage + pageOffset;
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
    },
    content: [
      {
        text: strategyName,
        fontSize: coverTitleFontSize,
        bold: true,
        alignment: 'center',
        margin: [0, coverTitleTopMargin, 0, 0],
      },
    ],
    pageSize: 'A4',
    pageOrientation,
    pageMargins: [15, 60, 15, 40],
    defaultStyle: { font: 'THSarabun', fontSize: 10 },
  };
};

/**
 * Per-group detail page (strategy → tactic → plan header + project rows).
 * One call per group; renderer-side caller drives the grouping outside.
 */
export const createSupplementGroupDetailDocDefinition = (
  params: Omit<SupplementDetailDocParams, 'projects'> & {
    groupProjects: any[];
    strategyName: string;
    /** Strategy code (e.g. STRAT001) — drives ordinal in จ. row */
    strategyCode?: string | null;
    tacticName: string;
    planName: string;
    pageOffset?: number;
    // Resolved external alignment for this (strategy, tactic, plan)
    // triple. `null` renders "—" for the ก./ข./ค./ง. rows; จ. always
    // shows the internal Strategy.
    alignment?: AlignmentRow | null;
  },
): TDocumentDefinitions | null => {
  const {
    developmentPlanSupplementName,
    years,
    groupProjects,
    availableColumns,
    columnMap,
    pageMargins,
    pageOrientation,
    newWord,
    reportType = 'default',
    strategyName,
    strategyCode = null,
    tacticName,
    planName,
    pageOffset = 0,
    alignment = null,
  } = params;

  if (!groupProjects || groupProjects.length === 0) {
    return null;
  }

  const content: any[] = [];

  // Compute available columns for this group based on origin-agency presence
  // of any row. Supplement is agency-only today (Q1/Q2), but the helper is
  // future-proofed and mirrors revision-edit conventions for layout parity.
  const anyHasOriginAgency = groupProjects.some(projectHasOriginAgency);

  const createGroupColumns = (hasOrigin: boolean): string[] => {
    let cols = availableColumns.filter(col => col !== 'amphoe' && col !== 'coordinates');
    if (hasOrigin) {
      const orderedColumns: string[] = [];
      const standardOrder = ['index', 'title', 'amphoe', 'objective', 'target', 'coordinates', 'budget', 'kpi', 'expectedResult', 'mainAgency'];
      const groupSet = new Set(cols);
      groupSet.add('amphoe');
      groupSet.add('coordinates');
      for (const col of standardOrder) {
        if (groupSet.has(col)) orderedColumns.push(col);
      }
      for (const col of cols) {
        if (!orderedColumns.includes(col) && col !== 'amphoe' && col !== 'coordinates') {
          orderedColumns.push(col);
        }
      }
      return orderedColumns;
    }
    return cols;
  };

  const groupColumns = createGroupColumns(anyHasOriginAgency);
  const totalColumns = groupColumns.length + (groupColumns.includes('budget') ? years.length - 1 : 0);

  // Group-level budget totals.
  const groupSumByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));
  const groupCountByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));
  for (const project of groupProjects) {
    if (project?.budgets) {
      for (const budget of project.budgets) {
        const year = budget.year;
        const value = parseFloat(budget.quantity);
        if (!isNaN(value) && groupSumByYear[year] !== undefined) {
          groupSumByYear[year] += value;
          groupCountByYear[year] += 1;
        }
      }
    }
  }

  // Title block (only on first page of the group).
  content.push({
    text: [
      { text: 'รายละเอียดโครงการ\n' },
      developmentPlanSupplementName + '\n',
      'องค์การบริหารส่วนจังหวัดนครราชสีมา\n',
    ],
    alignment: 'center',
    margin: [0, 0, 0, 10],
    fontSize: 12,
    bold: true,
    style: 'tableHeader',
  });

  // Build header rows for the project table.
  const buildHeaderRows = (): { headerRow1: any[]; headerRow2: any[] } => {
    const headerRow1: any[] = [];
    const headerRow2: any[] = [];
    groupColumns.forEach(col => {
      if (col === 'budget') {
        headerRow1.push({
          text: columnMap[col].text,
          colSpan: years.length,
          style: 'tableHeader2',
          alignment: 'center',
        });
        headerRow1.push(...Array.from({ length: years.length - 1 }, () => ({ text: '', style: 'tableHeader' })));
        headerRow2.push(...years.map(year => ({
          text: year.toString(),
          style: 'tableHeader',
          alignment: 'center',
          margin: [0, 2, 0, 0],
        })));
      } else {
        const marginTop = col === 'target' || col === 'coordinates' ? 3 : 10;
        headerRow1.push({
          text: columnMap[col].text,
          rowSpan: 2,
          style: 'tableHeader2',
          alignment: 'center',
          margin: [0, marginTop, 0, 0],
        });
        headerRow2.push({ text: '', style: 'tableHeader2' });
      }
    });
    return { headerRow1, headerRow2 };
  };

  // Build one row of cells for a single SPG project.
  const buildProjectRow = (project: any, projectIndex: number): any[] => {
    const row: any[] = [];
    groupColumns.forEach(col => {
      switch (col) {
        case 'index':
          row.push({ text: String(projectIndex), alignment: 'center' });
          break;
        case 'title':
          row.push({ text: newWord(project.title || '-'), font: 'THSarabun' });
          break;
        case 'objective':
          row.push({ text: newWord(project.objective || '-'), font: 'THSarabun' });
          break;
        case 'target':
          row.push({ text: newWord(project.goal || '-'), font: 'THSarabun' });
          break;
        case 'budget':
          row.push(...years.map(year => {
            const match = project.budgets?.find((b: any) => b.year === year);
            const value = match ? parseFloat(match.quantity) : NaN;
            return { text: isNaN(value) ? '' : value.toLocaleString('th-TH'), alignment: 'right' };
          }));
          break;
        case 'kpi':
          row.push({ text: newWord(project.indicator || '-'), font: 'THSarabun' });
          break;
        case 'expectedResult':
          row.push({ text: newWord(project.expected || '-'), font: 'THSarabun' });
          break;
        case 'mainAgency': {
          const agencyName = reportType !== 'inAuthority'
            ? 'ยังไม่ระบุ'
            : project.responsibleAgency?.name;
          row.push({ text: newWord(agencyName || '-'), font: 'THSarabun', alignment: 'center' });
          break;
        }
        case 'amphoe':
          row.push({ text: newWord(resolveAmphoeName(project)), font: 'THSarabun', alignment: 'center' });
          break;
        case 'coordinates': {
          const hasOrigin = project.originAgencyId || project.originAgency;
          if (hasOrigin) {
            row.push({
              text: newWord(formatCoordinates(project)),
              font: 'THSarabun',
              alignment: 'left',
              fontSize: 9,
              margin: [2, 2, 2, 2],
            });
          } else {
            row.push({ text: '-', font: 'THSarabun', alignment: 'center' });
          }
          break;
        }
        default:
          row.push({ text: '', alignment: 'center' });
      }
    });
    return row;
  };

  // Assemble the main table body: group header (strategy/tactic/plan),
  // column headers, then one row per project. Summary rows append at end.
  const tableBody: any[] = [];

  // QA-PDF-ALIGN-02 (2026-05-19) — header band: 5 external alignment
  // rows (ก. ข. ค. ง. จ.) → 1 Strategy/Tactic/Plan stack row → 2
  // column-header rows (appended after this block by the caller).
  // External alignment block FIRST (above the STP stack) per
  // source-of-truth template.
  const alignmentRows = buildExternalAlignmentRows(
    alignment ?? null,
    { code: strategyCode, name: strategyName },
    totalColumns,
  );
  for (const alignRow of alignmentRows) {
    tableBody.push(alignRow);
  }

  // Strategy/Tactic/Plan header row (full colspan).
  tableBody.push([
    {
      colSpan: totalColumns,
      stack: [
        { text: `ยุทธศาสตร์: ${strategyName}`, bold: true },
        { text: `กลยุทธ์: ${tacticName}`, bold: true, margin: [20, 0, 0, 0] },
        { text: `แผนงาน: ${planName}`, bold: true, margin: [40, 0, 0, 0] },
      ],
      border: [false, false, false, false],
    },
    ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
  ]);

  // Column header rows.
  const { headerRow1, headerRow2 } = buildHeaderRows();
  tableBody.push(headerRow1, headerRow2);

  // Project rows.
  groupProjects.forEach((project, idx) => {
    tableBody.push(buildProjectRow(project, idx + 1));
  });

  // Summary rows.
  if (groupColumns.includes('budget')) {
    const budgetColumnIndex = groupColumns.indexOf('budget');
    const columnsBeforeBudget = budgetColumnIndex > 0 ? groupColumns.slice(0, budgetColumnIndex) : [];
    const columnsAfterBudget = groupColumns.slice(budgetColumnIndex + 1);
    const summaryLabelColSpan = columnsBeforeBudget.length;

    const summaryRow: any[] = [];
    if (summaryLabelColSpan > 1) {
      summaryRow.push({ text: 'รวมงบประมาณ', alignment: 'center', bold: true, colSpan: summaryLabelColSpan });
      for (let i = 1; i < summaryLabelColSpan; i += 1) summaryRow.push({ text: '' });
    } else {
      summaryRow.push({ text: 'รวมงบประมาณ', alignment: 'center', bold: true });
    }
    summaryRow.push(
      ...years.map(year => ({
        text: groupSumByYear[year] ? groupSumByYear[year].toLocaleString('th-TH') : '',
        alignment: 'right',
        bold: true,
      })),
    );
    if (columnsAfterBudget.length > 0) {
      if (columnsAfterBudget.length > 1) {
        summaryRow.push({ text: '', alignment: 'center', bold: true, colSpan: columnsAfterBudget.length });
        for (let i = 1; i < columnsAfterBudget.length; i += 1) summaryRow.push({ text: '' });
      } else {
        summaryRow.push({ text: '', alignment: 'center', bold: true });
      }
    }
    tableBody.push(summaryRow);

    const countSummaryRow: any[] = [];
    if (summaryLabelColSpan > 1) {
      countSummaryRow.push({ text: 'รวมจำนวนโครงการ', alignment: 'right', bold: true, colSpan: summaryLabelColSpan });
      for (let i = 1; i < summaryLabelColSpan; i += 1) countSummaryRow.push({ text: '' });
    } else {
      countSummaryRow.push({ text: 'รวมจำนวนโครงการ', alignment: 'right', bold: true });
    }
    countSummaryRow.push(
      ...years.map(year => ({
        text: groupCountByYear[year] ? String(groupCountByYear[year]) : '',
        alignment: 'center',
        bold: true,
      })),
    );
    if (columnsAfterBudget.length > 0) {
      if (columnsAfterBudget.length > 1) {
        countSummaryRow.push({ text: '', alignment: 'center', bold: true, colSpan: columnsAfterBudget.length });
        for (let i = 1; i < columnsAfterBudget.length; i += 1) countSummaryRow.push({ text: '' });
      } else {
        countSummaryRow.push({ text: '', alignment: 'center', bold: true });
      }
    }
    tableBody.push(countSummaryRow);
  } else {
    tableBody.push([
      { text: `รวมจำนวนโครงการ: ${groupProjects.length}`, colSpan: totalColumns, alignment: 'center', bold: true },
      ...Array.from({ length: totalColumns - 1 }, () => ({ text: '' })),
    ]);
  }

  const columnWidths = calculateColumnWidths(groupColumns, years);

  content.push({
    // QA-PDF-ALIGN-02 (2026-05-19): headerRows = 8 = 5 external
    // alignment rows (ก. ข. ค. ง. จ.) + 1 Strategy/Tactic/Plan stack +
    // 2 column-header rows. Multi-page groups need all 8 pinned so the
    // alignment header band repeats on every page.
    table: { headerRows: 8, widths: columnWidths, body: tableBody },
    layout: {
      hLineWidth: (i: number, node: any) => {
        if (i === 0) return 0;
        if (node.table.body[i]?.[0]?.stack) return 0;
        return 0.3;
      },
      vLineWidth: () => 0.3,
      hLineColor: () => '#000',
      vLineColor: () => '#000',
    },
  });

  return {
    header: function () {
      return { text: 'แบบ ผ.02', alignment: 'right', fontSize: 11, margin: [0, 40, 20, 0] };
    },
    footer: function (currentPage: number) {
      const footerText = newWord
        ? newWord(developmentPlanSupplementName)
        : developmentPlanSupplementName;
      const pageNumber = currentPage + pageOffset;
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
    },
    content,
    pageSize: 'A4',
    pageOrientation,
    pageMargins: [15, 60, 15, 40],
    defaultStyle: { font: 'THSarabun', fontSize: 10 },
    styles: {
      tableHeader: { alignment: 'center', bold: true, fontSize: 11 },
      tableHeader2: { alignment: 'center', bold: true, fontSize: 10 },
    },
  };
};

