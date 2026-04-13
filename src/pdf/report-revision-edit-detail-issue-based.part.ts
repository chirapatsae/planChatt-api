import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { IssueBasedRevisionEditDetailDocParams } from './report.types';

// Helper function to check whether a value has changed
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
  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    if (oldValue.length !== newValue.length) return true;
    const oldMap = new Map(oldValue.map((b: any) => [b.year, b.quantity]));
    const newMap = new Map(newValue.map((b: any) => [b.year, b.quantity]));
    for (const [year, oldQty] of oldMap.entries()) {
      const newQty = newMap.get(year);
      if (parseFloat(oldQty) !== parseFloat(newQty)) return true;
    }
    return false;
  }
  return String(oldValue) !== String(newValue);
};

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

/**
 * Cover page for an issue-based revision group.
 * Displays "ประเด็นการพัฒนา: {issueName}" instead of
 * the strategy/tactic/plan triple used in STRATEGY_BASED.
 */
export const createIssueBasedRevisionGroupCoverPageDocDefinition = (
  issueName: string,
  developmentPlanRevisionName: string,
  pageMargins: [number, number, number, number],
  pageOrientation: 'portrait' | 'landscape',
  newWord?: (text: string) => any,
  pageOffset: number = 0,
): TDocumentDefinitions => {
  const pageSize = pageOrientation === 'landscape' ? { width: 842, height: 595 } : { width: 595, height: 842 };
  const availablePageHeight = pageSize.height - pageMargins[1] - pageMargins[3];
  const coverTitleFontSize = 48;
  const coverTitleTopMargin = Math.max(0, availablePageHeight / 2 - coverTitleFontSize / 2);

  return {
    header: function () {
      return null;
    },
    footer: function (currentPage: number, _pageCount: number) {
      const footerText = newWord ? newWord(developmentPlanRevisionName) : developmentPlanRevisionName;
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
 * Detail pages for an issue-based revision group.
 * Identical to the STRATEGY_BASED detail except:
 *   1. Group header shows "ประเด็นการพัฒนา: {issueName}" (single line)
 *   2. KPI column is excluded
 *   3. Comparison detects developmentIssue changes instead of strategy/tactic/plan
 */
export const createIssueBasedRevisionGroupDetailDocDefinition = (
  params: Omit<IssueBasedRevisionEditDetailDocParams, 'projects'> & {
    groupProjects: Array<{
      current: any;
      previous: any;
      oldAdditionDetail?: string | null;
      additionalDetail?: string | null;
    }>;
    issueName: string;
    pageOffset?: number;
  },
): TDocumentDefinitions | null => {
  const {
    developmentPlanRevisionName,
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

  if (groupProjects.length === 0) {
    return null;
  }

  // Strip KPI column - not applicable for ISSUE_BASED
  const filteredAvailableColumns = availableColumns.filter(col => col !== 'kpi');

  const content: any[] = [];

  // Title block
  content.push({
    text: [
      { text: 'รายละเอียดโครงการ\n' },
      developmentPlanRevisionName + '\n',
      'องค์การบริหารส่วนจังหวัดนครราชสีมา\n',
    ],
    alignment: 'center',
    margin: [0, 0, 0, 10],
    fontSize: 12,
    bold: true,
    style: 'tableHeader',
  });

  // Helper: detect origin agency presence
  const checkHasOriginAgency = (project: any): boolean => {
    const hasOriginAgencyId = project.originAgencyId &&
      typeof project.originAgencyId === 'object' &&
      project.originAgencyId !== null &&
      (project.originAgencyId.id || project.originAgencyId.name);
    const hasOriginAgencyObj = project.originAgency &&
      typeof project.originAgency === 'object' &&
      project.originAgency !== null &&
      (project.originAgency.id || project.originAgency.name);
    return hasOriginAgencyId || hasOriginAgencyObj;
  };

  // Helper: compute columns for a project based on origin agency presence
  const createGroupColumns = (projectHasOriginAgency: boolean): string[] => {
    let cols = filteredAvailableColumns.filter(col => col !== 'amphoe' && col !== 'coordinates');

    if (projectHasOriginAgency) {
      const orderedColumns: string[] = [];
      const standardOrder = ['index', 'title', 'amphoe', 'objective', 'target', 'coordinates', 'budget', 'expectedResult', 'mainAgency'];

      const groupSet = new Set(cols);
      groupSet.add('amphoe');
      groupSet.add('coordinates');

      for (const col of standardOrder) {
        if (groupSet.has(col)) {
          orderedColumns.push(col);
        }
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

  // Helper: build header rows for the detail table
  const buildHeaderRows = (groupColumns: string[]): { headerRow1: any[]; headerRow2: any[] } => {
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
        headerRow2.push(...years.map(year => ({ text: year.toString(), style: 'tableHeader', alignment: 'center', margin: [0, 2, 0, 0] })));
      } else {
        const marginTop = col === 'target' || col === 'coordinates' ? 3 : 10;
        headerRow1.push({ text: columnMap[col].text, rowSpan: 2, style: 'tableHeader2', alignment: 'center', margin: [0, marginTop, 0, 0] });
        headerRow2.push({ text: '', style: 'tableHeader2' });
      }
    });

    return { headerRow1, headerRow2 };
  };

  // Helper: render coordinate text
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

  // Helper: resolve amphoe name from project
  const resolveAmphoeName = (project: any): string => {
    const hasOrigin = project.originAgencyId || project.originAgency;
    if (!hasOrigin) return '-';
    return project.originAgencyId?.amphoe?.name
      || project.originAgency?.amphoe?.name
      || project.amphoe?.name
      || '-';
  };

  // Helper: build a row of cells for a project (used by both old and new tables)
  const buildProjectRow = (
    project: any,
    projectIndex: number,
    groupColumns: string[],
    cellStyleOverride?: Record<string, any>,
    changeFn?: (col: string) => boolean,
  ): any[] => {
    const row: any[] = [];

    groupColumns.forEach(col => {
      const isChanged = changeFn ? changeFn(col) : false;
      const cellStyle = isChanged ? { bold: true, ...(cellStyleOverride || {}) } : (cellStyleOverride || {});

      switch (col) {
        case 'index':
          row.push({ text: String(projectIndex), alignment: 'center', ...cellStyle });
          break;
        case 'title':
          row.push({ text: newWord(project.title || '-'), font: 'THSarabun', ...cellStyle });
          break;
        case 'objective':
          row.push({ text: newWord(project.objective || '-'), font: 'THSarabun', ...cellStyle });
          break;
        case 'target':
          row.push({ text: newWord(project.goal || '-'), font: 'THSarabun', ...cellStyle });
          break;
        case 'budget':
          row.push(...years.map(year => {
            const match = project.budgets?.find((b: any) => b.year === year);
            const value = match ? parseFloat(match.quantity) : NaN;
            const budgetChanged = changeFn ? changeFn('budget') : false;
            // Per-year change detection when previous exists
            let perYearChanged = budgetChanged;
            if (changeFn && !budgetChanged) {
              // fallback: already handled by changeFn returning true for 'budget'
            }
            return {
              text: isNaN(value) ? '' : value.toLocaleString('th-TH'),
              alignment: 'right',
              ...(perYearChanged ? { bold: true } : {}),
            };
          }));
          break;
        case 'expectedResult':
          row.push({ text: newWord(project.expected || '-'), font: 'THSarabun', ...cellStyle });
          break;
        case 'mainAgency':
          {
            const agencyName = reportType !== 'inAuthority'
              ? 'ยังไม่ระบุ'
              : project.responsibleAgency?.name;
            row.push({ text: newWord(agencyName || '-'), font: 'THSarabun', alignment: 'center', ...cellStyle });
          }
          break;
        case 'amphoe':
          row.push({ text: newWord(resolveAmphoeName(project)), font: 'THSarabun', alignment: 'center', ...cellStyle });
          break;
        case 'coordinates':
          {
            const hasOrigin = project.originAgencyId || project.originAgency;
            if (hasOrigin) {
              row.push({
                text: newWord(formatCoordinates(project)),
                font: 'THSarabun',
                alignment: 'left',
                fontSize: 9,
                margin: [2, 2, 2, 2],
                ...cellStyle,
              });
            } else {
              row.push({ text: '-', font: 'THSarabun', alignment: 'center', ...cellStyle });
            }
          }
          break;
        default:
          row.push({ text: '', alignment: 'center', ...cellStyle });
      }
    });

    return row;
  };

  // Helper: create the "old project" table (oldAdditionDetail + previous data)
  const createTableForOldProject = (
    project: {
      current: any;
      previous: any;
      oldAdditionDetail?: string | null;
      additionalDetail?: string | null;
    },
    projectIndex: number,
    groupColumns: string[],
    showHeader: boolean = true,
    pageBreakBefore: boolean = false,
  ) => {
    const { previous, oldAdditionDetail } = project;
    if (!previous && !oldAdditionDetail) {
      return null;
    }

    const totalColumns = groupColumns.length + (groupColumns.includes('budget') ? years.length - 1 : 0);
    const tableBody: any[] = [];

    // Old addition detail row (full colspan)
    if (oldAdditionDetail) {
      tableBody.push([
        {
          colSpan: totalColumns,
          text: newWord(oldAdditionDetail),
          font: 'THSarabun',
          fontSize: 10,
          bold: true,
          border: [true, false, true, false],
          margin: [5, 2, 5, 2],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
      ]);
    }

    // Previous project data row
    if (previous) {
      const oldRow = buildProjectRow(previous, projectIndex, groupColumns);
      tableBody.push(oldRow);
    }

    // Issue-based group header (single line)
    if (showHeader) {
      tableBody.unshift([
        {
          colSpan: totalColumns,
          stack: [
            { text: `ประเด็นการพัฒนา: ${issueName}`, bold: true },
          ],
          border: [false, false, false, false],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
      ]);
    }

    // Table column headers
    const { headerRow1, headerRow2 } = buildHeaderRows(groupColumns);
    if (showHeader) {
      tableBody.splice(1, 0, headerRow1, headerRow2);
    } else {
      tableBody.unshift(headerRow1, headerRow2);
    }

    const columnWidths = calculateColumnWidths(groupColumns, years);
    const headerRows = showHeader ? 3 : 2;

    return {
      table: { headerRows, widths: columnWidths, body: tableBody },
      layout: {
        hLineWidth: (i: number, node: any) => {
          if (showHeader && i === 0) return 0;
          if (node.table.body[i]?.[0]?.stack) return 0;
          return 0.3;
        },
        vLineWidth: () => 0.3,
        hLineColor: () => '#000',
        vLineColor: () => '#000',
      },
      pageBreak: pageBreakBefore ? 'before' : undefined,
    };
  };

  // Helper: create the "new project" table (additionalDetail + current data with change highlighting)
  const createTableForNewProject = (
    project: {
      current: any;
      previous: any;
      oldAdditionDetail?: string | null;
      additionalDetail?: string | null;
    },
    projectIndex: number,
    groupColumns: string[],
    _showHeader: boolean = false,
    isLastTable: boolean = false,
    groupSumByYear?: Record<number, number>,
    groupCountByYear?: Record<number, number>,
  ) => {
    const { current, previous, additionalDetail } = project;
    const totalColumns = groupColumns.length + (groupColumns.includes('budget') ? years.length - 1 : 0);
    const tableBody: any[] = [];

    // Addition detail row (full colspan)
    if (additionalDetail) {
      tableBody.push([
        {
          colSpan: totalColumns,
          text: newWord(additionalDetail),
          font: 'THSarabun',
          fontSize: 10,
          bold: true,
          border: [true, false, true, false],
          margin: [5, 2, 5, 2],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
      ]);
    }

    // Change detection function for ISSUE_BASED
    // Detects field-level changes; developmentIssue change replaces strategy/tactic/plan
    const detectChange = previous ? (col: string): boolean => {
      switch (col) {
        case 'title':
          return hasChanged(previous.title, current.title);
        case 'objective':
          return hasChanged(previous.objective, current.objective);
        case 'target':
          return hasChanged(previous.goal, current.goal);
        case 'budget':
          return hasChanged(previous.budgets, current.budgets);
        case 'expectedResult':
          return hasChanged(previous.expected, current.expected);
        case 'mainAgency':
          return hasChanged(previous.responsibleAgency?.name, current.responsibleAgency?.name);
        case 'amphoe': {
          const prevAmphoe = previous.originAgencyId?.amphoe?.name
            || previous.originAgency?.amphoe?.name
            || previous.amphoe?.name;
          const currAmphoe = current.originAgencyId?.amphoe?.name
            || current.originAgency?.amphoe?.name
            || current.amphoe?.name;
          return hasChanged(prevAmphoe, currAmphoe);
        }
        case 'coordinates':
          return hasChanged(
            { startLat: previous.startLat, startLng: previous.startLng, endLat: previous.endLat, endLng: previous.endLng },
            { startLat: current.startLat, startLng: current.startLng, endLat: current.endLat, endLng: current.endLng },
          );
        default:
          return false;
      }
    } : undefined;

    // Build current project data row with change highlighting
    const newRow: any[] = [];
    groupColumns.forEach(col => {
      const isChanged = detectChange ? detectChange(col) : false;
      const cellStyle = isChanged ? { bold: true } : {};

      switch (col) {
        case 'index':
          newRow.push({ text: String(projectIndex), alignment: 'center', ...cellStyle });
          break;
        case 'title':
          newRow.push({ text: newWord(current.title || '-'), font: 'THSarabun', ...cellStyle });
          break;
        case 'objective':
          newRow.push({ text: newWord(current.objective || '-'), font: 'THSarabun', ...cellStyle });
          break;
        case 'target':
          newRow.push({ text: newWord(current.goal || '-'), font: 'THSarabun', ...cellStyle });
          break;
        case 'budget':
          newRow.push(...years.map(year => {
            const match = current.budgets?.find((b: any) => b.year === year);
            const value = match ? parseFloat(match.quantity) : NaN;
            const prevMatch = previous?.budgets?.find((b: any) => b.year === year);
            const prevValue = prevMatch ? parseFloat(prevMatch.quantity) : NaN;
            const budgetChanged = previous ? hasChanged(prevValue, value) : false;
            return {
              text: isNaN(value) ? '' : value.toLocaleString('th-TH'),
              alignment: 'right',
              ...(budgetChanged ? { bold: true } : {}),
            };
          }));
          break;
        case 'expectedResult':
          newRow.push({ text: newWord(current.expected || '-'), font: 'THSarabun', ...cellStyle });
          break;
        case 'mainAgency':
          {
            const agencyName = reportType !== 'inAuthority'
              ? 'ยังไม่ระบุ'
              : current.responsibleAgency?.name;
            newRow.push({ text: newWord(agencyName || '-'), font: 'THSarabun', alignment: 'center', ...cellStyle });
          }
          break;
        case 'amphoe':
          {
            const hasOrigin = current.originAgencyId || current.originAgency;
            if (hasOrigin) {
              const amphoeName = current.originAgencyId?.amphoe?.name
                || current.originAgency?.amphoe?.name
                || current.amphoe?.name
                || '-';
              newRow.push({ text: newWord(amphoeName), font: 'THSarabun', alignment: 'center', ...cellStyle });
            } else {
              newRow.push({ text: '-', font: 'THSarabun', alignment: 'center', ...cellStyle });
            }
          }
          break;
        case 'coordinates':
          {
            const hasOrigin = current.originAgencyId || current.originAgency;
            if (hasOrigin) {
              newRow.push({
                text: newWord(formatCoordinates(current)),
                font: 'THSarabun',
                alignment: 'left',
                fontSize: 9,
                margin: [2, 2, 2, 2],
                ...cellStyle,
              });
            } else {
              newRow.push({ text: '-', font: 'THSarabun', alignment: 'center', ...cellStyle });
            }
          }
          break;
        default:
          newRow.push({ text: '', alignment: 'center', ...cellStyle });
      }
    });
    tableBody.push(newRow);

    // Table column headers
    const { headerRow1, headerRow2 } = buildHeaderRows(groupColumns);
    tableBody.unshift(headerRow1, headerRow2);

    // Summary rows (only on the last table in the group)
    if (isLastTable) {
      const finalSumByYear = groupSumByYear || {};
      const finalCountByYear = groupCountByYear || {};

      if (groupColumns.includes('budget')) {
        const budgetColumnIndex = groupColumns.indexOf('budget');
        const columnsBeforeBudget = budgetColumnIndex > 0 ? groupColumns.slice(0, budgetColumnIndex) : [];
        const columnsAfterBudget = groupColumns.slice(budgetColumnIndex + 1);
        const summaryLabelColSpan = columnsBeforeBudget.length;

        // Budget sum row
        const summaryRow: any[] = [];
        if (summaryLabelColSpan > 1) {
          summaryRow.push({ text: 'รวมงบประมาณ', alignment: 'center', bold: true, colSpan: summaryLabelColSpan });
          for (let i = 1; i < summaryLabelColSpan; i += 1) {
            summaryRow.push({ text: '' });
          }
        } else {
          summaryRow.push({ text: 'รวมงบประมาณ', alignment: 'center', bold: true });
        }
        summaryRow.push(
          ...years.map(year => ({
            text: finalSumByYear[year] ? finalSumByYear[year].toLocaleString('th-TH') : '',
            alignment: 'right',
            bold: true,
          })),
        );
        if (columnsAfterBudget.length > 0) {
          if (columnsAfterBudget.length > 1) {
            summaryRow.push({ text: '', alignment: 'center', bold: true, colSpan: columnsAfterBudget.length });
            for (let i = 1; i < columnsAfterBudget.length; i += 1) {
              summaryRow.push({ text: '' });
            }
          } else {
            summaryRow.push({ text: '', alignment: 'center', bold: true });
          }
        }
        tableBody.push(summaryRow);

        // Project count row
        const countSummaryRow: any[] = [];
        if (summaryLabelColSpan > 1) {
          countSummaryRow.push({ text: 'รวมจำนวนโครงการ', alignment: 'right', bold: true, colSpan: summaryLabelColSpan });
          for (let i = 1; i < summaryLabelColSpan; i += 1) {
            countSummaryRow.push({ text: '' });
          }
        } else {
          countSummaryRow.push({ text: 'รวมจำนวนโครงการ', alignment: 'right', bold: true });
        }
        countSummaryRow.push(
          ...years.map(year => ({
            text: finalCountByYear[year] ? String(finalCountByYear[year]) : '',
            alignment: 'center',
            bold: true,
          })),
        );
        if (columnsAfterBudget.length > 0) {
          if (columnsAfterBudget.length > 1) {
            countSummaryRow.push({ text: '', alignment: 'center', bold: true, colSpan: columnsAfterBudget.length });
            for (let i = 1; i < columnsAfterBudget.length; i += 1) {
              countSummaryRow.push({ text: '' });
            }
          } else {
            countSummaryRow.push({ text: '', alignment: 'center', bold: true });
          }
        }
        tableBody.push(countSummaryRow);
      } else {
        tableBody.push([
          { text: `รวมจำนวนโครงการ: 1`, colSpan: totalColumns, alignment: 'center', bold: true },
          ...Array.from({ length: totalColumns - 1 }, () => ({ text: '' })),
        ]);
      }
    }

    const columnWidths = calculateColumnWidths(groupColumns, years);

    return {
      table: { headerRows: 2, widths: columnWidths, body: tableBody },
      layout: {
        hLineWidth: () => 0.3,
        vLineWidth: () => 0.3,
        hLineColor: () => '#000',
        vLineColor: () => '#000',
      },
      pageBreak: previous ? 'before' : undefined,
    };
  };

  // Compute group-level budget totals from current projects
  const groupSumByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));
  const groupCountByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));

  for (const project of groupProjects) {
    if (project.current && project.current.budgets) {
      for (const budget of project.current.budgets) {
        const year = budget.year;
        const value = parseFloat(budget.quantity);
        if (!isNaN(value) && groupSumByYear[year] !== undefined) {
          groupSumByYear[year] += value;
          groupCountByYear[year] += 1;
        }
      }
    }
  }

  // Build tables for each project in the group
  let projectIndex = 1;
  for (let i = 0; i < groupProjects.length; i++) {
    const project = groupProjects[i];
    const currentHasOriginAgency = checkHasOriginAgency(project.current);
    const cols = createGroupColumns(currentHasOriginAgency);
    const showHeader = i === 0;

    // Determine whether old-project table needs a page break before it
    const prevProject = i > 0 ? groupProjects[i - 1] : null;
    const shouldPageBreakOld = prevProject && prevProject.previous && project.previous;

    // Old project table (if previous exists)
    const oldTable = createTableForOldProject(
      project,
      projectIndex,
      cols,
      showHeader,
      !!shouldPageBreakOld,
    );

    if (oldTable) {
      content.push(oldTable);
    }

    // New project table (current with change highlighting)
    const isLastTable = i === groupProjects.length - 1;
    const newTable = createTableForNewProject(
      project,
      projectIndex++,
      cols,
      false,
      isLastTable,
      groupSumByYear,
      groupCountByYear,
    );

    if (newTable) {
      content.push(newTable);
    }
  }

  return {
    header: function () {
      return { text: 'แบบ ผ.02', alignment: 'right', fontSize: 11, margin: [0, 40, 20, 0] };
    },
    footer: function (currentPage: number, _pageCount: number) {
      const footerText = newWord ? newWord(developmentPlanRevisionName) : developmentPlanRevisionName;
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
