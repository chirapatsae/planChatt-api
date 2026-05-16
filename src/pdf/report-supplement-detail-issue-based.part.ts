/**
 * SUPP_PRINT_BE_02 — ISSUE_BASED supplement detail renderer.
 *
 * Mirrors `report-revision-edit-detail-issue-based.part.ts` adapted for
 * `SupplementProjectGroup`:
 *   - No previous-version comparison (supplement is additive).
 *   - Groups by `DevelopmentIssue` (§16.5 ISSUE_BASED shape).
 *   - KPI column OMITTED per §16 ISSUE_BASED contract.
 *
 * This file only renders the per-issue group cover sheets + the per-project
 * detail tables. There is no supplement-wide cover page — the summary page
 * leads the document, mirroring revision-edit.
 */

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { IssueBasedSupplementDetailDocParams } from './report.types';

const calculateColumnWidths = (selectedCols: string[], years: number[]): string[] => {
  if (selectedCols.length === 0) {
    return [];
  }

  const widths: number[] = [];
  const baseWidths: Record<string, number> = {
    index: 5,
    title: 14,
    objective: 14,
    target: 18,
    expectedResult: 14,
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
 * Per-issue cover page (issue header). Lightweight intra-document cover
 * that prefixes each development-issue block.
 */
export const createIssueBasedSupplementGroupCoverPageDocDefinition = (
  issueName: string,
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
        text: `ประเด็นการพัฒนา: ${issueName}`,
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
 * Per-issue detail page (issue header + project rows). One call per issue
 * group; renderer-side caller drives the grouping outside.
 */
export const createIssueBasedSupplementGroupDetailDocDefinition = (
  params: Omit<IssueBasedSupplementDetailDocParams, 'projects'> & {
    groupProjects: any[];
    issueName: string;
    pageOffset?: number;
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
    issueName,
    pageOffset = 0,
  } = params;

  if (!groupProjects || groupProjects.length === 0) return null;

  // Strip KPI column unconditionally — not applicable for ISSUE_BASED.
  const filteredAvailableColumns = availableColumns.filter(col => col !== 'kpi');

  const content: any[] = [];

  // Compute available columns for this group.
  const anyHasOriginAgency = groupProjects.some(projectHasOriginAgency);

  const createGroupColumns = (hasOrigin: boolean): string[] => {
    let cols = filteredAvailableColumns.filter(col => col !== 'amphoe' && col !== 'coordinates');
    if (hasOrigin) {
      const orderedColumns: string[] = [];
      const standardOrder = ['index', 'title', 'amphoe', 'objective', 'target', 'coordinates', 'budget', 'expectedResult', 'mainAgency'];
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

  const tableBody: any[] = [];

  // Issue header row (full colspan, single line).
  tableBody.push([
    {
      colSpan: totalColumns,
      stack: [{ text: `ประเด็นการพัฒนา: ${issueName}`, bold: true }],
      border: [false, false, false, false],
    },
    ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
  ]);

  const { headerRow1, headerRow2 } = buildHeaderRows();
  tableBody.push(headerRow1, headerRow2);

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
    table: { headerRows: 3, widths: columnWidths, body: tableBody },
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

