import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { IssueBasedProjectDetailDocParams } from './report.types';

/**
 * Calculate column widths for issue-based detail tables.
 * Same logic as the strategy-based version but without the 'kpi' column.
 */
const calculateColumnWidths = (
  selectedCols: string[],
  years: number[],
): string[] => {
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
    mainAgency: 9,
    amphoe: 8,
    coordinates: 9,
  };

  const nonBudgetColumns = selectedCols.filter((col) => col !== 'budget');
  const usedWidth = nonBudgetColumns.reduce(
    (sum, col) => sum + (baseWidths[col] ?? 10),
    0,
  );
  const budgetWidth = selectedCols.includes('budget')
    ? Math.max(45, 100 - usedWidth)
    : 0;

  selectedCols.forEach((col) => {
    if (col === 'budget') {
      const budgetWidthPerYear = years.length
        ? Math.max(6, Math.floor(budgetWidth / years.length))
        : budgetWidth;
      years.forEach(() => widths.push(budgetWidthPerYear));
    } else {
      const baseWidth = baseWidths[col] ?? 10;
      const adjustedWidth =
        nonBudgetColumns.length <= 3 ? baseWidth * 1.5 : baseWidth;
      widths.push(adjustedWidth);
    }
  });

  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  if (Math.abs(totalWidth - 100) > 0.1 && widths.length > 0) {
    const adjustment = (100 - totalWidth) / widths.length;
    return widths.map((width) => `${(width + adjustment).toFixed(2)}%`);
  }

  return widths.map((width) => `${width}%`);
};

// ---------------------------------------------------------------------------
// Cover page for a single DevelopmentIssue group
// ---------------------------------------------------------------------------
export const createIssueBasedGroupCoverPageDocDefinition = (
  issueName: string,
  developmentPlanName: string,
  pageMargins: [number, number, number, number],
  pageOrientation: 'portrait' | 'landscape',
  newWord?: (text: string) => any,
  pageOffset: number = 0,
): TDocumentDefinitions => {
  const pageSize =
    pageOrientation === 'landscape'
      ? { width: 842, height: 595 }
      : { width: 595, height: 842 };
  const availablePageHeight = pageSize.height - pageMargins[1] - pageMargins[3];
  const coverTitleFontSize = 48;
  const coverTitleTopMargin = Math.max(
    0,
    availablePageHeight / 2 - coverTitleFontSize / 2,
  );

  return {
    header: function () {
      return null; // No header on cover page
    },
    footer: function (currentPage: number) {
      const footerText = newWord
        ? newWord(developmentPlanName)
        : developmentPlanName;
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

// ---------------------------------------------------------------------------
// Detail tables for a single DevelopmentIssue group
// ---------------------------------------------------------------------------
export const createIssueBasedGroupDetailDocDefinition = (
  params: Omit<IssueBasedProjectDetailDocParams, 'groupedProjects'> & {
    groupProjects: any[];
    issueName: string;
    pageOffset?: number;
  },
): TDocumentDefinitions | null => {
  const {
    developmentPlanName,
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

  const content: any[] = [];

  const pushSpannedCells = (row: any[], span: number, cell: any) => {
    if (span <= 0) return;
    if (span === 1) {
      row.push(cell);
      return;
    }
    row.push({ ...cell, colSpan: span });
    for (let i = 1; i < span; i += 1) {
      row.push({ text: '' });
    }
  };

  // Helper: build a table for a contiguous set of projects
  const createTableForProjects = (
    projects: any[],
    groupColumns: string[],
    startIndex: number = 1,
    showHeader: boolean = true,
    pageBreakBefore: boolean = false,
    isLastTable: boolean = false,
    groupSumByYear?: Record<number, number>,
    groupCountByYear?: Record<number, number>,
  ) => {
    if (projects.length === 0) return null;

    const tableBody: any[] = [];
    const totalColumns =
      groupColumns.length +
      (groupColumns.includes('budget') ? years.length - 1 : 0);
    const sumByYear: Record<number, number> = Object.fromEntries(
      years.map((year) => [year, 0]),
    );
    const countByYear: Record<number, number> = Object.fromEntries(
      years.map((year) => [year, 0]),
    );

    // Sub-header: single line "ประเด็นการพัฒนา: {issueName}"
    if (showHeader) {
      tableBody.push([
        {
          colSpan: totalColumns,
          text: `ประเด็นการพัฒนา: ${issueName}`,
          bold: true,
          border: [false, false, false, false],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({
          text: '',
          border: [false, false, false, false],
        })),
      ]);
    }

    // Table column headers (row 1 + row 2)
    const headerRow1: any[] = [];
    const headerRow2: any[] = [];
    groupColumns.forEach((col) => {
      if (col === 'budget') {
        headerRow1.push({
          text: columnMap[col].text,
          colSpan: years.length,
          style: 'tableHeader2',
          alignment: 'center',
        });
        headerRow1.push(
          ...Array.from({ length: years.length - 1 }, () => ({
            text: '',
            style: 'tableHeader',
          })),
        );
        headerRow2.push(
          ...years.map((year) => ({
            text: year.toString(),
            style: 'tableHeader',
            alignment: 'center',
            margin: [0, 2, 0, 0],
          })),
        );
      } else {
        // 2026-05-21 — `mainAgency` has 2-line header text; drop to 6pt.
        const marginTop =
          col === 'target' || col === 'coordinates'
            ? 3
            : col === 'mainAgency'
            ? 6
            : 10;
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
    tableBody.push(headerRow1, headerRow2);

    // Project data rows
    let idx = startIndex;
    for (const project of projects) {
      const rowData: any[] = [];
      groupColumns.forEach((col) => {
        switch (col) {
          case 'index':
            rowData.push({ text: String(idx++), alignment: 'center' });
            break;
          case 'title':
            rowData.push({
              text: newWord(project.title),
              font: 'THSarabun',
            });
            break;
          case 'objective':
            rowData.push({
              text: newWord(project.objective),
              font: 'THSarabun',
            });
            break;
          case 'target':
            rowData.push({
              text: newWord(project.goal),
              font: 'THSarabun',
            });
            break;
          case 'budget':
            rowData.push(
              ...years.map((year) => {
                const match = project.budgets?.find(
                  (b: any) => b.year === year,
                );
                const value = match ? parseFloat(match.quantity) : NaN;
                if (!isNaN(value)) {
                  sumByYear[year] += value;
                  countByYear[year] += 1;
                }
                return {
                  text: isNaN(value)
                    ? ''
                    : value.toLocaleString('th-TH'),
                  alignment: 'right',
                };
              }),
            );
            break;
          // NOTE: 'kpi' case is intentionally omitted for ISSUE_BASED format
          case 'expectedResult':
            rowData.push({
              text: newWord(project.expected),
              font: 'THSarabun',
            });
            break;
          case 'mainAgency': {
            const agencyName =
              reportType === 'inAuthority'
                ? 'ยังไม่ระบุ'
                : project.responsibleAgency?.name;
            rowData.push({
              text: newWord(agencyName || '-'),
              font: 'THSarabun',
              alignment: 'center',
            });
            break;
          }
          case 'amphoe': {
            const hasOriginAgencyId =
              project.originAgencyId &&
              typeof project.originAgencyId === 'object' &&
              project.originAgencyId !== null &&
              (project.originAgencyId.id || project.originAgencyId.name);
            const hasOriginAgencyObj =
              project.originAgency &&
              typeof project.originAgency === 'object' &&
              project.originAgency !== null &&
              (project.originAgency.id || project.originAgency.name);

            if (hasOriginAgencyId || hasOriginAgencyObj) {
              const amphoeName =
                project.originAgencyId?.amphoe?.name ||
                project.originAgency?.amphoe?.name ||
                project.amphoe?.name ||
                '-';
              rowData.push({
                text: newWord(amphoeName),
                font: 'THSarabun',
                alignment: 'center',
              });
            } else {
              rowData.push({
                text: '-',
                font: 'THSarabun',
                alignment: 'center',
              });
            }
            break;
          }
          case 'coordinates': {
            const hasOriginAgencyIdCoord =
              project.originAgencyId &&
              typeof project.originAgencyId === 'object' &&
              project.originAgencyId !== null &&
              (project.originAgencyId.id || project.originAgencyId.name);
            const hasOriginAgencyCoord =
              project.originAgency &&
              typeof project.originAgency === 'object' &&
              project.originAgency !== null &&
              (project.originAgency.id || project.originAgency.name);

            if (hasOriginAgencyIdCoord || hasOriginAgencyCoord) {
              const startLat =
                project.startLat != null ? Number(project.startLat) : null;
              const startLng =
                project.startLng != null ? Number(project.startLng) : null;
              const endLat =
                project.endLat != null ? Number(project.endLat) : null;
              const endLng =
                project.endLng != null ? Number(project.endLng) : null;

              let coordText = '-';
              if (
                startLat != null &&
                !isNaN(startLat) &&
                startLng != null &&
                !isNaN(startLng)
              ) {
                const startLatFmt =
                  startLat >= 0
                    ? `N ${startLat.toFixed(6)}°`
                    : `S ${Math.abs(startLat).toFixed(6)}°`;
                const startLngFmt =
                  startLng >= 0
                    ? `E ${startLng.toFixed(6)}°`
                    : `W ${Math.abs(startLng).toFixed(6)}°`;

                if (
                  endLat != null &&
                  !isNaN(endLat) &&
                  endLng != null &&
                  !isNaN(endLng)
                ) {
                  const endLatFmt =
                    endLat >= 0
                      ? `N ${endLat.toFixed(6)}°`
                      : `S ${Math.abs(endLat).toFixed(6)}°`;
                  const endLngFmt =
                    endLng >= 0
                      ? `E ${endLng.toFixed(6)}°`
                      : `W ${Math.abs(endLng).toFixed(6)}°`;
                  coordText = `จุดเริ่มต้น\n${startLatFmt}\n${startLngFmt}\n\nจุดสิ้นสุด\n${endLatFmt}\n${endLngFmt}`;
                } else {
                  coordText = `จุดเริ่มต้น\n${startLatFmt}\n${startLngFmt}`;
                }
              }
              rowData.push({
                text: newWord(coordText),
                font: 'THSarabun',
                alignment: 'left',
                fontSize: 9,
                margin: [2, 2, 2, 2],
              });
            } else {
              rowData.push({
                text: '-',
                font: 'THSarabun',
                alignment: 'center',
              });
            }
            break;
          }
          default:
            rowData.push({ text: '', alignment: 'center' });
        }
      });
      tableBody.push(rowData);
    }

    // Summary rows (only on the last table of the group)
    if (isLastTable) {
      const finalSumByYear = groupSumByYear || sumByYear;
      const finalCountByYear = groupCountByYear || countByYear;

      if (groupColumns.includes('budget')) {
        const budgetColumnIndex = groupColumns.indexOf('budget');
        const columnsBeforeBudget =
          budgetColumnIndex > 0
            ? groupColumns.slice(0, budgetColumnIndex)
            : [];
        const columnsAfterBudget = groupColumns.slice(budgetColumnIndex + 1);
        const summaryLabelColSpan = columnsBeforeBudget.length;

        const summaryRow: any[] = [];
        if (summaryLabelColSpan > 0) {
          pushSpannedCells(summaryRow, summaryLabelColSpan, {
            text: 'รวมงบประมาณ',
            alignment: 'center',
            bold: true,
          });
        } else {
          summaryRow.push({
            text: 'รวมงบประมาณ',
            alignment: 'center',
            bold: true,
          });
        }
        summaryRow.push(
          ...years.map((year) => ({
            text: finalSumByYear[year]
              ? finalSumByYear[year].toLocaleString('th-TH')
              : '',
            alignment: 'right',
            bold: true,
          })),
        );
        if (columnsAfterBudget.length > 0) {
          pushSpannedCells(summaryRow, columnsAfterBudget.length, {
            text: '',
            alignment: 'center',
            bold: true,
          });
        }
        tableBody.push(summaryRow);

        const countSummaryRow: any[] = [];
        if (summaryLabelColSpan > 0) {
          pushSpannedCells(countSummaryRow, summaryLabelColSpan, {
            text: 'รวมจำนวนโครงการ',
            alignment: 'right',
            bold: true,
          });
        } else {
          countSummaryRow.push({
            text: 'รวมจำนวนโครงการ',
            alignment: 'center',
            bold: true,
          });
        }
        countSummaryRow.push(
          ...years.map((year) => ({
            text: finalCountByYear[year]
              ? String(finalCountByYear[year])
              : '',
            alignment: 'center',
            bold: true,
          })),
        );
        if (columnsAfterBudget.length > 0) {
          pushSpannedCells(countSummaryRow, columnsAfterBudget.length, {
            text: '',
            alignment: 'center',
            bold: true,
          });
        }
        tableBody.push(countSummaryRow);
      } else {
        tableBody.push([
          {
            text: `รวมจำนวนโครงการ: ${projects.length}`,
            colSpan: totalColumns,
            alignment: 'center',
            bold: true,
          },
          ...Array.from({ length: totalColumns - 1 }, () => ({ text: '' })),
        ]);
      }
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

  // Helper: check whether a project has originAgency data
  const hasOriginAgency = (project: any): boolean => {
    const hasOriginAgencyId =
      project.originAgencyId &&
      typeof project.originAgencyId === 'object' &&
      project.originAgencyId !== null &&
      (project.originAgencyId.id || project.originAgencyId.name);
    const hasOriginAgencyObj =
      project.originAgency &&
      typeof project.originAgency === 'object' &&
      project.originAgency !== null &&
      (project.originAgency.id || project.originAgency.name);
    return hasOriginAgencyId || hasOriginAgencyObj;
  };

  // Helper: derive the column set, adding amphoe/coordinates when originAgency
  // is present, and stripping 'kpi' since ISSUE_BASED has no KPI column.
  const createAvailableColumns = (hasOrigin: boolean): string[] => {
    // Always filter out 'kpi' for issue-based format
    let cols = availableColumns.filter(
      (col) => col !== 'amphoe' && col !== 'coordinates' && col !== 'kpi',
    );

    if (hasOrigin) {
      const orderedColumns: string[] = [];
      // Standard order WITHOUT kpi
      const standardOrder = [
        'index',
        'title',
        'amphoe',
        'objective',
        'target',
        'coordinates',
        'budget',
        'expectedResult',
        'mainAgency',
      ];

      const groupSet = new Set(cols);
      groupSet.add('amphoe');
      groupSet.add('coordinates');

      for (const col of standardOrder) {
        if (groupSet.has(col)) {
          orderedColumns.push(col);
        }
      }

      for (const col of cols) {
        if (
          !orderedColumns.includes(col) &&
          col !== 'amphoe' &&
          col !== 'coordinates'
        ) {
          orderedColumns.push(col);
        }
      }

      return orderedColumns;
    }

    return cols;
  };

  // Pre-compute group-wide budget totals
  const groupSumByYear: Record<number, number> = Object.fromEntries(
    years.map((year) => [year, 0]),
  );
  const groupCountByYear: Record<number, number> = Object.fromEntries(
    years.map((year) => [year, 0]),
  );

  for (const project of groupProjects) {
    if (project.budgets) {
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

  // Split projects into sub-tables when originAgency presence changes
  let currentGroup: any[] = [];
  let currentHasOriginAgency: boolean | null = null;
  let isFirstTable = true;
  let firstProjectHasOriginAgency: boolean | null = null;
  const allTables: Array<{
    group: any[];
    hasOriginAgency: boolean;
    showHeader: boolean;
    pageBreak: boolean;
  }> = [];

  for (let i = 0; i < groupProjects.length; i++) {
    const project = groupProjects[i];
    const projectHasOriginAgency = hasOriginAgency(project);

    if (i === 0) {
      currentGroup = [project];
      currentHasOriginAgency = projectHasOriginAgency;
      firstProjectHasOriginAgency = projectHasOriginAgency;
    } else {
      if (firstProjectHasOriginAgency === projectHasOriginAgency) {
        currentGroup.push(project);
      } else {
        if (currentGroup.length > 0) {
          allTables.push({
            group: currentGroup,
            hasOriginAgency: currentHasOriginAgency!,
            showHeader: isFirstTable,
            pageBreak: !isFirstTable,
          });
          isFirstTable = false;
        }
        currentGroup = [project];
        currentHasOriginAgency = projectHasOriginAgency;
        firstProjectHasOriginAgency = projectHasOriginAgency;
      }
    }
  }

  if (currentGroup.length > 0) {
    allTables.push({
      group: currentGroup,
      hasOriginAgency: currentHasOriginAgency!,
      showHeader: isFirstTable,
      pageBreak: !isFirstTable,
    });
  }

  // Title block on the first page of this detail section
  content.push({
    text: [
      { text: 'รายละเอียดโครงการ\n' },
      developmentPlanName + '\n',
      'องค์การบริหารส่วนจังหวัดนครราชสีมา\n',
    ],
    alignment: 'center',
    margin: [0, 0, 0, 10],
    fontSize: 12,
    bold: true,
    style: 'tableHeader',
  });

  // Build all sub-tables
  let projectIndex = 1;
  for (let tableIdx = 0; tableIdx < allTables.length; tableIdx++) {
    const tableInfo = allTables[tableIdx];
    const isLastTable = tableIdx === allTables.length - 1;
    const cols = createAvailableColumns(tableInfo.hasOriginAgency);

    const prevTableHasOriginAgency =
      tableIdx > 0 ? allTables[tableIdx - 1].hasOriginAgency : null;
    const shouldShowHeader =
      tableInfo.showHeader ||
      (prevTableHasOriginAgency !== null &&
        prevTableHasOriginAgency !== tableInfo.hasOriginAgency);

    const shouldPageBreak = tableIdx > 0 ? tableInfo.pageBreak : false;

    const table = createTableForProjects(
      tableInfo.group,
      cols,
      projectIndex,
      shouldShowHeader,
      shouldPageBreak,
      isLastTable,
      groupSumByYear,
      groupCountByYear,
    );
    if (table) {
      content.push(table);
    }
    projectIndex += tableInfo.group.length;
  }

  return {
    header: function () {
      return {
        text: 'แบบ ผ.02',
        alignment: 'right',
        fontSize: 11,
        margin: [0, 40, 20, 0],
      };
    },
    footer: function (currentPage: number) {
      const footerText = newWord
        ? newWord(developmentPlanName)
        : developmentPlanName;
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
