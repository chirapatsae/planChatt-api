import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { ProjectDetailDocParams } from './report.types';
// BE-MAIN-01 — four-row external alignment block (NS / MS / SDG / PS)
// rendered between the Strategy/Tactic/Plan stack and the column
// headers. STRATEGY_BASED main-plan only; ISSUE_BASED renderer is
// untouched.
import type { AlignmentRow } from 'src/project-alignment-mapping/types/alignment.types';
import { buildExternalAlignmentBlock } from './report-external-alignment.part';

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

// สร้าง cover page สำหรับแต่ละ group (ไม่มี header "แบบ ผ.02")
export const createGroupCoverPageDocDefinition = (
  strategyName: string,
  developmentPlanName: string,
  pageMargins: [number, number, number, number],
  pageOrientation: 'portrait' | 'landscape',
  newWord?: (text: string) => any,
  pageOffset: number = 0, // offset สำหรับเลขหน้า (เริ่มจาก reportSummary)
): TDocumentDefinitions => {
  const pageSize = pageOrientation === 'landscape' ? { width: 842, height: 595 } : { width: 595, height: 842 };
  const availablePageHeight = pageSize.height - pageMargins[1] - pageMargins[3];
  const coverTitleFontSize = 48;
  const coverTitleTopMargin = Math.max(0, availablePageHeight / 2 - coverTitleFontSize / 2);

  return {
    header: function () {
      return null; // ไม่แสดง header ใน cover page
    },
    footer: function (currentPage: number, pageCount: number) {
      const footerText = newWord ? newWord(developmentPlanName) : developmentPlanName;
      // pageOffset ควรเป็นจำนวนหน้าที่ผ่านมาแล้ว ดังนั้น currentPage + pageOffset จะได้เลขหน้าที่ถูกต้อง
      const pageNumber = currentPage + pageOffset;
      return {
        columns: [
          { text: '', width: '*' }, // dummy ซ้าย
          // ตรงกลาง (ชื่อแผน)
          {
            text: footerText,
            alignment: 'center',
            width: 'auto',
            fontSize: 12,
            bold: true,
          },
          // เลขหน้า (มี margin ขวาเพิ่ม)
          {
            text: String(pageNumber),
            alignment: 'right',
            width: '*',
            margin: [0, 0, 20, 0], // เว้นขวา 20px
            fontSize: 12,
            bold: true,
          },
        ],
        margin: [15, 0, 15, 20], // margin footer ทั้งก้อน
      };
    },
    content: [
      {
        text: strategyName,
        fontSize: coverTitleFontSize,
        bold: true,
        alignment: 'center',
        margin: [0, coverTitleTopMargin, 0, 0], // ลด margin bottom เป็น 0 เพื่อไม่ให้เกิดหน้าเปล่า
      },
    ],
    pageSize: 'A4',
    pageOrientation,
    pageMargins: [15, 60, 15, 40],
    defaultStyle: { font: 'THSarabun', fontSize: 10 },
  };
};

// สร้าง detail page สำหรับแต่ละ group (มี header "แบบ ผ.02" ทุกหน้า)
export const createGroupDetailDocDefinition = (
  params: Omit<ProjectDetailDocParams, 'groupedProjects'> & {
    groupProjects: any[];
    strategyName: string;
    /**
     * Strategy code (e.g. `STRAT001`). Used to render the ordinal in
     * the จ. row of the external-alignment header block.
     */
    strategyCode?: string | null;
    tacticName: string;
    planName: string;
    pageOffset?: number;
    // Resolved external alignment for this (strategy, tactic, plan)
    // triple. `null` renders "—" for the ก./ข./ค./ง. rows; the จ. row
    // ALWAYS renders the internal Strategy regardless of alignment.
    alignment?: AlignmentRow | null;
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
    strategyName,
    strategyCode = null,
    tacticName,
    planName,
    pageOffset = 0, // offset สำหรับเลขหน้า (เริ่มจาก reportSummary)
    alignment = null,
  } = params;

  if (groupProjects.length === 0) {
    return null;
  }

  const content: any[] = [];
  const pushSpannedCells = (row: any[], span: number, cell: any) => {
    if (span <= 0) {
      return;
    }
    if (span === 1) {
      row.push(cell);
      return;
    }
    row.push({ ...cell, colSpan: span });
    for (let i = 1; i < span; i += 1) {
      row.push({ text: '' });
    }
  };

  // Helper function เพื่อสร้าง table สำหรับกลุ่มโครงการ
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
    const totalColumns = groupColumns.length + (groupColumns.includes('budget') ? years.length - 1 : 0);
    const sumByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));
    const countByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));

    // 2026-05-21 — external alignment (ก-จ) is now emitted OUTSIDE the
    // table (see return value below). Only the Strategy/Tactic/Plan
    // stack stays inside the table so that pdfmake `headerRows` keeps
    // STP + column headers pinned on continuation pages, while ก-จ
    // appears ONCE on the first page of each group (the page that
    // carries the "รายละเอียดโครงการ" cover title).
    if (showHeader) {
      tableBody.push([
        {
          colSpan: totalColumns,
          stack: [
            { text: `ยุทธศาสตร์: ${strategyName}`, bold: true, lineHeight: 1.2 },
            { text: `กลยุทธ์: ${tacticName}`, bold: true, margin: [20, 0, 0, 0], lineHeight: 1.2 },
            { text: `แผนงาน: ${planName}`, bold: true, margin: [40, 0, 0, 0], lineHeight: 1.2 },
          ],
          border: [false, false, false, false],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
      ]);
    }

    // สร้าง header table
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
        // 2026-05-21 — `mainAgency` has 2-line header text
        // ("หน่วยงาน\nรับผิดชอบหลัก") so the 10pt top margin used for
        // single-line headers pushed it too far down. Drop to 6pt so it
        // sits visually centered within the 2-row header band.
        const marginTop = col === 'target' || col === 'coordinates'
          ? 3
          : col === 'mainAgency'
          ? 6
          : 10;
        headerRow1.push({ text: columnMap[col].text, rowSpan: 2, style: 'tableHeader2', alignment: 'center', margin: [0, marginTop, 0, 0] });
        headerRow2.push({ text: '', style: 'tableHeader2' });
      }
    });
    tableBody.push(headerRow1, headerRow2);

    // เติมข้อมูล project (ใช้โค้ดเดิมจาก createTableForProjects)
    let idx = startIndex;
    for (const project of projects) {
      const rowData: any[] = [];
      groupColumns.forEach(col => {
        switch (col) {
          case 'index':
            rowData.push({ text: String(idx++), alignment: 'center' });
            break;
          case 'title':
            rowData.push({ text: newWord(project.title), font: 'THSarabun' });
            break;
          case 'objective':
            rowData.push({ text: newWord(project.objective), font: 'THSarabun' });
            break;
          case 'target':
            rowData.push({ text: newWord(project.goal), font: 'THSarabun' });
            break;
          case 'budget':
            rowData.push(...years.map(year => {
              const match = project.budgets?.find((b: any) => b.year === year);
              const value = match ? parseFloat(match.quantity) : NaN;
              if (!isNaN(value)) {
                sumByYear[year] += value;
                countByYear[year] += 1;
              }
              return { text: isNaN(value) ? '' : value.toLocaleString('th-TH'), alignment: 'right' };
            }));
            break;
          case 'kpi':
            rowData.push({ text: newWord(project.indicator), font: 'THSarabun' });
            break;
          case 'expectedResult':
            rowData.push({ text: newWord(project.expected), font: 'THSarabun' });
            break;
          case 'mainAgency':
            {
              const agencyName = reportType === 'inAuthority'
                ? 'ยังไม่ระบุ'
                : project.responsibleAgency?.name;
              rowData.push({ text: newWord(agencyName || '-'), font: 'THSarabun', alignment: 'center' });
            }
            break;
          case 'amphoe':
            {
              const hasOriginAgencyId = project.originAgencyId &&
                typeof project.originAgencyId === 'object' &&
                project.originAgencyId !== null &&
                (project.originAgencyId.id || project.originAgencyId.name);
              const hasOriginAgency = project.originAgency &&
                typeof project.originAgency === 'object' &&
                project.originAgency !== null &&
                (project.originAgency.id || project.originAgency.name);

              if (hasOriginAgencyId || hasOriginAgency) {
                const amphoeName = project.originAgencyId?.amphoe?.name
                  || project.originAgency?.amphoe?.name
                  || project.amphoe?.name
                  || '-';
                rowData.push({ text: newWord(amphoeName), font: 'THSarabun', alignment: 'center' });
              } else {
                rowData.push({ text: '-', font: 'THSarabun', alignment: 'center' });
              }
            }
            break;
          case 'coordinates':
            {
              const hasOriginAgencyId = project.originAgencyId &&
                typeof project.originAgencyId === 'object' &&
                project.originAgencyId !== null &&
                (project.originAgencyId.id || project.originAgencyId.name);
              const hasOriginAgency = project.originAgency &&
                typeof project.originAgency === 'object' &&
                project.originAgency !== null &&
                (project.originAgency.id || project.originAgency.name);

              if (hasOriginAgencyId || hasOriginAgency) {
                const startLat = project.startLat != null ? Number(project.startLat) : null;
                const startLng = project.startLng != null ? Number(project.startLng) : null;
                const endLat = project.endLat != null ? Number(project.endLat) : null;
                const endLng = project.endLng != null ? Number(project.endLng) : null;

                let coordText = '-';
                if (startLat != null && !isNaN(startLat) && startLng != null && !isNaN(startLng)) {
                  const startLatFormatted = startLat >= 0 ? `N ${startLat.toFixed(6)}°` : `S ${Math.abs(startLat).toFixed(6)}°`;
                  const startLngFormatted = startLng >= 0 ? `E ${startLng.toFixed(6)}°` : `W ${Math.abs(startLng).toFixed(6)}°`;

                  if (endLat != null && !isNaN(endLat) && endLng != null && !isNaN(endLng)) {
                    const endLatFormatted = endLat >= 0 ? `N ${endLat.toFixed(6)}°` : `S ${Math.abs(endLat).toFixed(6)}°`;
                    const endLngFormatted = endLng >= 0 ? `E ${endLng.toFixed(6)}°` : `W ${Math.abs(endLng).toFixed(6)}°`;
                    coordText = `จุดเริ่มต้น\n${startLatFormatted}\n${startLngFormatted}\n\nจุดสิ้นสุด\n${endLatFormatted}\n${endLngFormatted}`;
                  } else {
                    coordText = `จุดเริ่มต้น\n${startLatFormatted}\n${startLngFormatted}`;
                  }
                }
                rowData.push({
                  text: newWord(coordText),
                  font: 'THSarabun',
                  alignment: 'left',
                  fontSize: 9,
                  margin: [2, 2, 2, 2]
                });
              } else {
                rowData.push({ text: '-', font: 'THSarabun', alignment: 'center' });
              }
            }
            break;
          default:
            rowData.push({ text: '', alignment: 'center' });
        }
      });
      tableBody.push(rowData);
    }

    // แสดง summary rows เฉพาะเมื่อเป็น table สุดท้าย
    if (isLastTable) {
      const finalSumByYear = groupSumByYear || sumByYear;
      const finalCountByYear = groupCountByYear || countByYear;

      if (groupColumns.includes('budget')) {
        const budgetColumnIndex = groupColumns.indexOf('budget');
        const columnsBeforeBudget = budgetColumnIndex > 0 ? groupColumns.slice(0, budgetColumnIndex) : [];
        const columnsAfterBudget = groupColumns.slice(budgetColumnIndex + 1);
        const summaryLabelColSpan = columnsBeforeBudget.length;

        const summaryRow: any[] = [];
        if (summaryLabelColSpan > 0) {
          pushSpannedCells(summaryRow, summaryLabelColSpan, { text: 'รวมงบประมาณ', alignment: 'center', bold: true });
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
          pushSpannedCells(summaryRow, columnsAfterBudget.length, { text: '', alignment: 'center', bold: true });
        }
        tableBody.push(summaryRow);

        const countSummaryRow: any[] = [];
        if (summaryLabelColSpan > 0) {
          pushSpannedCells(countSummaryRow, summaryLabelColSpan, { text: 'รวมจำนวนโครงการ', alignment: 'right', bold: true });
        } else {
          countSummaryRow.push({ text: 'รวมจำนวนโครงการ', alignment: 'center', bold: true });
        }
        countSummaryRow.push(
          ...years.map(year => ({
            text: finalCountByYear[year] ? String(finalCountByYear[year]) : '',
            alignment: 'center',
            bold: true,
          })),
        );
        if (columnsAfterBudget.length > 0) {
          pushSpannedCells(countSummaryRow, columnsAfterBudget.length, { text: '', alignment: 'center', bold: true });
        }
        tableBody.push(countSummaryRow);
      } else {
        tableBody.push([
          { text: `รวมจำนวนโครงการ: ${projects.length}`, colSpan: totalColumns, alignment: 'center', bold: true },
          ...Array.from({ length: totalColumns - 1 }, () => ({ text: '' })),
        ]);
      }
    }

    const columnWidths = calculateColumnWidths(groupColumns, years);
    // QA-PDF-ALIGN-02 (2026-05-21) — table opens with:
    //   1 row  Strategy/Tactic/Plan stack
    // + 2 rows column headers (headerRow1 + headerRow2)
    // = 3 header rows. showHeader=false continuation tables emit only
    // the 2 column-header rows so the value stays at 2.
    //
    // The 5-line external-alignment (ก. ข. ค. ง. จ.) block lives
    // OUTSIDE the table — see the wrapping `stack` below. That way
    // pdfmake's per-page header repeat only covers STP + column
    // headers, and ก-จ appears once at the top of each group.
    const headerRows = showHeader ? 3 : 2;

    const tableContent = {
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
        // 2026-05-21 — strip vertical cell padding from stack rows so
        // the STP stack reads with the same tight spacing as the
        // standalone ก-จ block above it. The two now form ONE flowing
        // header band on the first page of each group.
        paddingTop: (i: number, node: any) => (node.table.body[i]?.[0]?.stack ? 0 : 2),
        paddingBottom: (i: number, node: any) => (node.table.body[i]?.[0]?.stack ? 0 : 2),
      },
    } as any;

    // Wrap ก-จ + table in a single stack so they share a pageBreak
    // boundary. When showHeader=false (continuation table) we skip the
    // ก-จ block entirely.
    if (showHeader) {
      return {
        stack: [
          buildExternalAlignmentBlock(alignment, { code: strategyCode, name: strategyName }),
          tableContent,
        ],
        pageBreak: pageBreakBefore ? 'before' : undefined,
      } as any;
    }
    return {
      ...tableContent,
      pageBreak: pageBreakBefore ? 'before' : undefined,
    };
  };

  // Helper functions (ใช้โค้ดเดิม)
  const hasOriginAgency = (project: any): boolean => {
    const hasOriginAgencyId = project.originAgencyId &&
      typeof project.originAgencyId === 'object' &&
      project.originAgencyId !== null &&
      (project.originAgencyId.id || project.originAgencyId.name);
    const hasOriginAgency = project.originAgency &&
      typeof project.originAgency === 'object' &&
      project.originAgency !== null &&
      (project.originAgency.id || project.originAgency.name);
    return hasOriginAgencyId || hasOriginAgency;
  };

  const createAvailableColumns = (hasOriginAgency: boolean): string[] => {
    let cols = availableColumns.filter(col => col !== 'amphoe' && col !== 'coordinates');

    if (hasOriginAgency) {
      const orderedColumns: string[] = [];
      const standardOrder = ['index', 'title', 'amphoe', 'objective', 'target', 'coordinates', 'budget', 'kpi', 'expectedResult', 'mainAgency'];

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

  // คำนวณ sumByYear และ countByYear ของทั้ง group
  const groupSumByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));
  const groupCountByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));

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

  // แบ่งโครงการตามเงื่อนไข originAgency และสร้าง table แยกกัน
  let projectIndex = 1;
  let currentGroup: any[] = [];
  let currentHasOriginAgency: boolean | null = null;
  let isFirstTable = true;
  let firstProjectHasOriginAgency: boolean | null = null;
  const allTables: Array<{ group: any[]; hasOriginAgency: boolean; showHeader: boolean; pageBreak: boolean }> = [];

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
            pageBreak: !isFirstTable
          });
          projectIndex += currentGroup.length;
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
      pageBreak: !isFirstTable
    });
  }

  // เพิ่มข้อความ "รายละเอียดโครงการ..." ในหน้าแรกของ detail page
  content.push({
    text: [
      { text: 'รายละเอียดโครงการ\n' },
      developmentPlanName + '\n',
      'เทศบาลตำบลหนองกระทุ่ม จังหวัดนครราชสีมา\n',
    ],
    alignment: 'center',
    margin: [0, 0, 0, 10],
    fontSize: 12,
    bold: true,
    style: 'tableHeader',
  });

  // สร้าง table ทั้งหมด
  projectIndex = 1;
  for (let tableIdx = 0; tableIdx < allTables.length; tableIdx++) {
    const tableInfo = allTables[tableIdx];
    const isLastTable = tableIdx === allTables.length - 1;
    const cols = createAvailableColumns(tableInfo.hasOriginAgency);

    const prevTableHasOriginAgency = tableIdx > 0 ? allTables[tableIdx - 1].hasOriginAgency : null;
    const shouldShowHeader = tableInfo.showHeader || (prevTableHasOriginAgency !== null && prevTableHasOriginAgency !== tableInfo.hasOriginAgency);

    // table แรกไม่ควรมี pageBreak เพราะเป็นหน้าแรกของ detail page
    // (cover page แยกออกไปแล้ว)
    const shouldPageBreak = tableIdx > 0 ? tableInfo.pageBreak : false;

    const table = createTableForProjects(
      tableInfo.group,
      cols,
      projectIndex,
      shouldShowHeader,
      shouldPageBreak,
      isLastTable,
      groupSumByYear,
      groupCountByYear
    );
    if (table) {
      content.push(table);
    }
    projectIndex += tableInfo.group.length;
  }

  return {
    header: function () {
      // แสดง "แบบ ผ.02" ทุกหน้า
      return { text: 'แบบ ผ.02', alignment: 'right', fontSize: 11, margin: [0, 40, 20, 0] };
    },
    footer: function (currentPage: number, pageCount: number) {
      const footerText = newWord ? newWord(developmentPlanName) : developmentPlanName;
      // pageOffset ควรเป็นจำนวนหน้าที่ผ่านมาแล้ว ดังนั้น currentPage + pageOffset จะได้เลขหน้าที่ถูกต้อง
      const pageNumber = currentPage + pageOffset;
      return {
        columns: [
          { text: '', width: '*' }, // dummy ซ้าย
          // ตรงกลาง (ชื่อแผน)
          {
            text: footerText,
            alignment: 'center',
            width: 'auto',
            fontSize: 12,
            bold: true,
          },
          // เลขหน้า (มี margin ขวาเพิ่ม)
          {
            text: String(pageNumber),
            alignment: 'right',
            width: '*',
            margin: [0, 0, 20, 0], // เว้นขวา 20px
            fontSize: 12,
            bold: true,
          },
        ],
        margin: [15, 0, 15, 20], // margin footer ทั้งก้อน
      };
    },
    content,
    pageSize: 'A4',
    pageOrientation,
    pageMargins: [15, 60, 15, 40],
    defaultStyle: { font: 'THSarabun', fontSize: 10 },
    styles: {
      tableHeader: { alignment: 'center', bold: true, fontSize: 11 },
      tableHeader2: { alignment: 'center', bold: true, fontSize: 10 }
    },
  };
};
  
// Function เดิม (ยังคงไว้เพื่อ backward compatibility)
export const createProjectDetailPartDocDefinition = (params: ProjectDetailDocParams): TDocumentDefinitions | null => {
  const {
    developmentPlanName,
    years,
    groupedProjects,
    availableColumns,
    columnMap,
    pageMargins,
    pageOrientation,
    newWord,
    reportType = 'default',
  } = params;

  if (groupedProjects.size === 0) {
    return null;
  }

  const pageSize = pageOrientation === 'landscape' ? { width: 842, height: 595 } : { width: 595, height: 842 };
  const availablePageHeight = pageSize.height - pageMargins[1] - pageMargins[3];
  const coverTitleFontSize = 48;
  const coverTitleTopMargin = Math.max(0, availablePageHeight / 2 - coverTitleFontSize / 2);

  const content: any[] = [];
  let isFirstGroup = true;
  // เก็บ index ของ content array ที่เป็น cover page
  const coverPageContentIndexes: number[] = [];
  // เก็บข้อมูล cover page แต่ละอัน: { contentIndex, hasPageBreakBefore, estimatedPageNumber }
  const coverPageInfo: Array<{ contentIndex: number; hasPageBreakBefore: boolean; estimatedPageNumber?: number }> = [];
  const pushSpannedCells = (row: any[], span: number, cell: any) => {
    if (span <= 0) {
      return;
    }
    if (span === 1) {
      row.push(cell);
      return;
    }
    row.push({ ...cell, colSpan: span });
    for (let i = 1; i < span; i += 1) {
      row.push({ text: '' });
    }
  };

  // Helper function เพื่อสร้าง table สำหรับกลุ่มโครงการ
  const createTableForProjects = (
    projects: any[],
    groupColumns: string[],
    strategyName: string,
    tacticName: string,
    planName: string,
    startIndex: number = 1,
    showHeader: boolean = true,
    pageBreakBefore: boolean = false,
    isLastTable: boolean = false,
    groupSumByYear?: Record<number, number>,
    groupCountByYear?: Record<number, number>
  ) => {
    if (projects.length === 0) return null;

    const tableBody: any[] = [];
    const totalColumns = groupColumns.length + (groupColumns.includes('budget') ? years.length - 1 : 0);
    const sumByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));
    const countByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));

    // แสดงหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน" เฉพาะเมื่อ showHeader = true
    if (showHeader) {
    tableBody.push([
      {
        colSpan: totalColumns,
        stack: [
          { text: `ยุทธศาสตร์: ${strategyName}`, bold: true, lineHeight: 1.2 },
          { text: `กลยุทธ์: ${tacticName}`, bold: true, margin: [20, 0, 0, 0], lineHeight: 1.2 },
          { text: `แผนงาน: ${planName}`, bold: true, margin: [40, 0, 0, 0], lineHeight: 1.2 },
        ],
        border: [false, false, false, false],
      },
      ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
    ]);
    }

    // สร้าง header table
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
        // เอา marginTop ออกสำหรับคอลัมน์ target
        // 2026-05-21 — `mainAgency` has 2-line header text
        // ("หน่วยงาน\nรับผิดชอบหลัก") so the 10pt top margin used for
        // single-line headers pushed it too far down. Drop to 6pt so it
        // sits visually centered within the 2-row header band.
        const marginTop = col === 'target' || col === 'coordinates'
          ? 3
          : col === 'mainAgency'
          ? 6
          : 10;
        headerRow1.push({ text: columnMap[col].text, rowSpan: 2, style: 'tableHeader2', alignment: 'center', margin: [0, marginTop, 0, 0] });
        headerRow2.push({ text: '', style: 'tableHeader2' });
      }
    });
    tableBody.push(headerRow1, headerRow2);

    // เติมข้อมูล project
    let idx = startIndex;
    for (const project of projects) {
      const rowData: any[] = [];
      groupColumns.forEach(col => {
        switch (col) {
          case 'index':
            rowData.push({ text: String(idx++), alignment: 'center' });
            break;
          case 'title':
            rowData.push({ text: newWord(project.title), font: 'THSarabun' });
            break;
          case 'objective':
            rowData.push({ text: newWord(project.objective), font: 'THSarabun' });
            break;
          case 'target':
            rowData.push({ text: newWord(project.goal), font: 'THSarabun' });
            break;
          case 'budget':
            rowData.push(...years.map(year => {
              const match = project.budgets?.find((b: any) => b.year === year);
              const value = match ? parseFloat(match.quantity) : NaN;
              if (!isNaN(value)) {
                sumByYear[year] += value;
                countByYear[year] += 1;
              }
              return { text: isNaN(value) ? '' : value.toLocaleString('th-TH'), alignment: 'right' };
            }));
            break;
          case 'kpi':
            rowData.push({ text: newWord(project.indicator), font: 'THSarabun' });
            break;
          case 'expectedResult':
            rowData.push({ text: newWord(project.expected), font: 'THSarabun' });
            break;
          case 'mainAgency':
            {
              const agencyName = reportType !== 'inAuthority'
                ? 'ยังไม่ระบุ'
                : project.responsibleAgency?.name;
              rowData.push({ text: newWord(agencyName || '-'), font: 'THSarabun', alignment: 'center' });
            }
            break;
          case 'amphoe':
            {
              // ตรวจสอบว่าโครงการมี originAgency หรือไม่
              const hasOriginAgencyId = project.originAgencyId && 
                typeof project.originAgencyId === 'object' && 
                project.originAgencyId !== null &&
                (project.originAgencyId.id || project.originAgencyId.name);
              const hasOriginAgency = project.originAgency && 
                typeof project.originAgency === 'object' && 
                project.originAgency !== null &&
                (project.originAgency.id || project.originAgency.name);
              
              if (hasOriginAgencyId || hasOriginAgency) {
                const amphoeName = project.originAgencyId?.amphoe?.name 
                  || project.originAgency?.amphoe?.name 
                  || project.amphoe?.name 
                  || '-';
                rowData.push({ text: newWord(amphoeName), font: 'THSarabun', alignment: 'center' });
              } else {
                rowData.push({ text: '-', font: 'THSarabun', alignment: 'center' });
              }
            }
            break;
          case 'coordinates':
            {
              // ตรวจสอบว่าโครงการมี originAgency หรือไม่
              const hasOriginAgencyId = project.originAgencyId && 
                typeof project.originAgencyId === 'object' && 
                project.originAgencyId !== null &&
                (project.originAgencyId.id || project.originAgencyId.name);
              const hasOriginAgency = project.originAgency && 
                typeof project.originAgency === 'object' && 
                project.originAgency !== null &&
                (project.originAgency.id || project.originAgency.name);
              
              if (hasOriginAgencyId || hasOriginAgency) {
                const startLat = project.startLat != null ? Number(project.startLat) : null;
                const startLng = project.startLng != null ? Number(project.startLng) : null;
                const endLat = project.endLat != null ? Number(project.endLat) : null;
                const endLng = project.endLng != null ? Number(project.endLng) : null;
                
                let coordText = '-';
                if (startLat != null && !isNaN(startLat) && startLng != null && !isNaN(startLng)) {
                  const startLatFormatted = startLat >= 0 ? `N ${startLat.toFixed(6)}°` : `S ${Math.abs(startLat).toFixed(6)}°`;
                  const startLngFormatted = startLng >= 0 ? `E ${startLng.toFixed(6)}°` : `W ${Math.abs(startLng).toFixed(6)}°`;
                  
                  if (endLat != null && !isNaN(endLat) && endLng != null && !isNaN(endLng)) {
                    const endLatFormatted = endLat >= 0 ? `N ${endLat.toFixed(6)}°` : `S ${Math.abs(endLat).toFixed(6)}°`;
                    const endLngFormatted = endLng >= 0 ? `E ${endLng.toFixed(6)}°` : `W ${Math.abs(endLng).toFixed(6)}°`;
                    coordText = `จุดเริ่มต้น\n${startLatFormatted}\n${startLngFormatted}\n\nจุดสิ้นสุด\n${endLatFormatted}\n${endLngFormatted}`;
                  } else {
                    coordText = `จุดเริ่มต้น\n${startLatFormatted}\n${startLngFormatted}`;
                  }
                }
                rowData.push({ 
                  text: newWord(coordText), 
                  font: 'THSarabun', 
                  alignment: 'left',
                  fontSize: 9,
                  margin: [2, 2, 2, 2]
                });
              } else {
                rowData.push({ text: '-', font: 'THSarabun', alignment: 'center' });
              }
            }
            break;
          default:
            rowData.push({ text: '', alignment: 'center' });
        }
      });
      tableBody.push(rowData);
    }

    // แสดง summary rows เฉพาะเมื่อเป็น table สุดท้ายของ group
    if (isLastTable) {
      // ใช้ข้อมูลจาก groupSumByYear และ groupCountByYear ถ้ามี (เป็นผลรวมของทั้ง group)
      const finalSumByYear = groupSumByYear || sumByYear;
      const finalCountByYear = groupCountByYear || countByYear;

      if (groupColumns.includes('budget')) {
        const budgetColumnIndex = groupColumns.indexOf('budget');
        const columnsBeforeBudget = budgetColumnIndex > 0 ? groupColumns.slice(0, budgetColumnIndex) : [];
        const columnsAfterBudget = groupColumns.slice(budgetColumnIndex + 1);
      const summaryLabelColSpan = columnsBeforeBudget.length;

      const summaryRow: any[] = [];
      if (summaryLabelColSpan > 0) {
        pushSpannedCells(summaryRow, summaryLabelColSpan, { text: 'รวมงบประมาณ', alignment: 'center', bold: true });
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
        pushSpannedCells(summaryRow, columnsAfterBudget.length, { text: '', alignment: 'center', bold: true });
      }
      tableBody.push(summaryRow);

      const countSummaryRow: any[] = [];
      if (summaryLabelColSpan > 0) {
        pushSpannedCells(countSummaryRow, summaryLabelColSpan, { text: 'รวมจำนวนโครงการ', alignment: 'right', bold: true });
      } else {
        countSummaryRow.push({ text: 'รวมจำนวนโครงการ', alignment: 'center', bold: true });
      }
      countSummaryRow.push(
        ...years.map(year => ({
            text: finalCountByYear[year] ? String(finalCountByYear[year]) : '',
          alignment: 'center',
          bold: true,
        })),
      );
      if (columnsAfterBudget.length > 0) {
        pushSpannedCells(countSummaryRow, columnsAfterBudget.length, { text: '', alignment: 'center', bold: true });
      }
      tableBody.push(countSummaryRow);
    } else {
      tableBody.push([
          { text: `รวมจำนวนโครงการ: ${projects.length}`, colSpan: totalColumns, alignment: 'center', bold: true },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '' })),
      ]);
    }
    }

    const columnWidths = calculateColumnWidths(groupColumns, years);

    // headerRows จะทำให้ header แสดงซ้ำในหน้าใหม่เมื่อ table ยาวขึ้น
    // ถ้ามีหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน" ให้ headerRows = 3 (รวม row หัวตาราง + headerRow1 + headerRow2)
    // ถ้าไม่มีหัวตาราง ให้ headerRows = 2 (headerRow1 + headerRow2)
    const headerRows = showHeader ? 3 : 2;

    return {
      table: { headerRows, widths: columnWidths, body: tableBody },
      layout: { 
        hLineWidth: (i, node) => {
          // ถ้าเป็น row หัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน" หรือ summary rows ให้ไม่มีเส้นขอบ
          if (showHeader && i === 0) return 0; // หัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน"
          if (node.table.body[i]?.[0]?.stack) return 0; // หัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน"
          return 0.3;
        }, 
        vLineWidth: () => 0.3, 
        hLineColor: () => '#000', 
        vLineColor: () => '#000' 
      },
      pageBreak: pageBreakBefore ? 'before' : undefined,
    };
  };

  // Helper function เพื่อตรวจสอบว่าโครงการมี originAgency หรือไม่
  const hasOriginAgency = (project: any): boolean => {
    const hasOriginAgencyId = project.originAgencyId && 
      typeof project.originAgencyId === 'object' && 
      project.originAgencyId !== null &&
      (project.originAgencyId.id || project.originAgencyId.name);
    const hasOriginAgency = project.originAgency && 
      typeof project.originAgency === 'object' && 
      project.originAgency !== null &&
      (project.originAgency.id || project.originAgency.name);
    return hasOriginAgencyId || hasOriginAgency;
  };

  // Helper function เพื่อสร้าง availableColumns ตามเงื่อนไข originAgency
  const createAvailableColumns = (hasOriginAgency: boolean): string[] => {
    let cols = availableColumns.filter(col => col !== 'amphoe' && col !== 'coordinates');
    
    if (hasOriginAgency) {
      const orderedColumns: string[] = [];
      const standardOrder = ['index', 'title', 'amphoe', 'objective', 'target', 'coordinates', 'budget', 'kpi', 'expectedResult', 'mainAgency'];
      
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

  for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
    const [strategyName, tacticName, planName] = groupKey.split('||');

    // สร้าง cover page (เฉพาะครั้งแรกของ group)
    // เก็บ index ของ content array ที่เป็น cover page
    const coverPageIndex = content.length;
    const hasPageBreakBefore = !isFirstGroup;
    coverPageContentIndexes.push(coverPageIndex);
    coverPageInfo.push({
      contentIndex: coverPageIndex,
      hasPageBreakBefore,
    });
    
    // เพิ่ม custom property เพื่อ mark ว่าเป็น cover page
    content.push({
      text: strategyName,
      fontSize: coverTitleFontSize,
      bold: true,
      alignment: 'center',
      margin: [0, coverTitleTopMargin, 0, coverTitleTopMargin],
      pageBreak: hasPageBreakBefore ? 'before' : undefined,
      _isCoverPage: true, // Custom property เพื่อ mark ว่าเป็น cover page
      _coverPageIndex: coverPageInfo.length - 1, // Index ใน coverPageInfo array
    });
    isFirstGroup = false;

    // รายละเอียดหลัง cover (เฉพาะครั้งแรกของ group)
    // content.push({
    //   text: [
    //     { text: 'รายละเอียดโครงการ\n' },
    //     developmentPlanName + '\n',
    //     'เทศบาลตำบลหนองกระทุ่ม จังหวัดนครราชสีมา\n',
    //   ],
    //   alignment: 'center',
    //   margin: [0, 0, 0, 0],
    //   fontSize: 12,
    //   bold: true,
    //   style: 'tableHeader',
    // });

    // คำนวณ sumByYear และ countByYear ของทั้ง group ก่อน
    const groupSumByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));
    const groupCountByYear: Record<number, number> = Object.fromEntries(years.map(year => [year, 0]));
    
    for (const project of groupProjectsValue) {
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

    // แบ่งโครงการตามเงื่อนไข originAgency และสร้าง table แยกกัน
    let projectIndex = 1;
    let currentGroup: any[] = [];
    let currentHasOriginAgency: boolean | null = null;
    let isFirstTable = true;
    let firstProjectHasOriginAgency: boolean | null = null;
    const allTables: Array<{ group: any[]; hasOriginAgency: boolean; showHeader: boolean; pageBreak: boolean }> = [];

    for (let i = 0; i < groupProjectsValue.length; i++) {
      const project = groupProjectsValue[i];
      const projectHasOriginAgency = hasOriginAgency(project);

      // โครงการแรก (i === 0) → มีหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน"
      if (i === 0) {
        currentGroup = [project];
        currentHasOriginAgency = projectHasOriginAgency;
        firstProjectHasOriginAgency = projectHasOriginAgency;
      } 
      // โครงการที่ 2 เป็นต้นไป → เช็ค originAgency เทียบกับโครงการแรก
      else {
        // ถ้าเงื่อนไข originAgency ตรงกับโครงการแรก → แสดงต่อใน table เดียวกัน (ไม่ต้องแยก table)
        if (firstProjectHasOriginAgency === projectHasOriginAgency) {
          currentGroup.push(project);
        } 
        // ถ้าเงื่อนไข originAgency ไม่ตรงกัน → ขึ้นหน้าใหม่และทำหัวตารางใหม่ (ต้องมี "ยุทธศาสตร์ กลยุทธ์ แผนงาน")
        else {
          // เก็บ table ก่อนหน้า
          if (currentGroup.length > 0) {
            allTables.push({
              group: currentGroup,
              hasOriginAgency: currentHasOriginAgency!,
              showHeader: isFirstTable, // แสดงหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน" เฉพาะ table แรก
              pageBreak: !isFirstTable // ขึ้นหน้าใหม่สำหรับ table ที่ไม่ใช่ table แรก
            });
            projectIndex += currentGroup.length;
            isFirstTable = false;
          }

          // เริ่ม group ใหม่ (ขึ้นหน้าใหม่) - ใช้เงื่อนไข originAgency ของโครงการใหม่
          currentGroup = [project];
          currentHasOriginAgency = projectHasOriginAgency;
          firstProjectHasOriginAgency = projectHasOriginAgency; // อัพเดท firstProjectHasOriginAgency สำหรับ group ใหม่
          // แสดงหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน" เพราะเงื่อนไขไม่ตรงกัน
        }
      }
    }

    // เก็บ table สุดท้าย
    if (currentGroup.length > 0) {
      allTables.push({
        group: currentGroup,
        hasOriginAgency: currentHasOriginAgency!,
        showHeader: isFirstTable, // แสดงหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน" เฉพาะ table แรก
        pageBreak: !isFirstTable // ขึ้นหน้าใหม่สำหรับ table ที่ไม่ใช่ table แรก
      });
    }

    // สร้าง table ทั้งหมด
    projectIndex = 1;
    for (let tableIdx = 0; tableIdx < allTables.length; tableIdx++) {
      const tableInfo = allTables[tableIdx];
      const isLastTable = tableIdx === allTables.length - 1;
      const cols = createAvailableColumns(tableInfo.hasOriginAgency);
      
      // ตรวจสอบว่าเงื่อนไข originAgency ตรงกับ table ก่อนหน้าหรือไม่
      const prevTableHasOriginAgency = tableIdx > 0 ? allTables[tableIdx - 1].hasOriginAgency : null;
      // แสดงหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน" เมื่อ:
      // 1. เป็น table แรก (isFirstTable)
      // 2. หรือเงื่อนไข originAgency ไม่ตรงกับ table ก่อนหน้า
      const shouldShowHeader = tableInfo.showHeader || (prevTableHasOriginAgency !== null && prevTableHasOriginAgency !== tableInfo.hasOriginAgency);
      
      const table = createTableForProjects(
        tableInfo.group,
        cols,
        strategyName,
        tacticName,
        planName,
        projectIndex,
        shouldShowHeader, // แสดงหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน" เมื่อเป็น table แรก หรือเงื่อนไขไม่ตรงกัน
        tableInfo.pageBreak, // ขึ้นหน้าใหม่สำหรับ table ที่ไม่ใช่ table แรก
        isLastTable, // แสดง summary rows เฉพาะ table สุดท้าย
        groupSumByYear, // ส่งผลรวมของทั้ง group
        groupCountByYear // ส่งจำนวนโครงการของทั้ง group
      );
      if (table) {
        content.push(table);
      }
      projectIndex += tableInfo.group.length;
    }
  }

  // ใช้ closure เพื่อคำนวณเลขหน้าของ cover page อย่างแม่นยำ
  // โดยคำนวณจาก content array, pageBreak, และประมาณการจำนวนหน้าที่ table ใช้
  const calculateCoverPageNumbers = (pageSize: any, pageMargins: number[]): Set<number> => {
    const coverPageNumbers = new Set<number>();
    let currentPageNumber = 1;
    
    // คำนวณพื้นที่ที่ใช้ได้ต่อหน้า (หัก margins)
    const availableHeight = pageSize.height - pageMargins[1] - pageMargins[3]; // top + bottom margins
    const availableWidth = pageSize.width - pageMargins[0] - pageMargins[2]; // left + right margins
    
    // วนลูป content array เพื่อหาว่า cover page อยู่หน้าไหน
    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      
      // ถ้ามี pageBreak: 'before' จะขึ้นหน้าใหม่
      if (item.pageBreak === 'before' || (item.table && item.table.pageBreak === 'before')) {
        currentPageNumber += 1;
      }
      
      // ถ้าเป็น cover page ให้เก็บเลขหน้าปัจจุบัน
      if (item._isCoverPage === true) {
        coverPageNumbers.add(currentPageNumber);
      }
      
      // ถ้าเป็น table อาจใช้หลายหน้า
      // เราจะประมาณการจำนวนหน้าที่ table ใช้จากจำนวน rows และ row height
      if (item.table && item.table.body) {
        const tableRows = item.table.body.length;
        const headerRows = item.table.headerRows || 0;
        const dataRows = tableRows - headerRows;
        
        // ประมาณการ row height (ขึ้นอยู่กับ font size และ content)
        // สำหรับ font size 10: ประมาณ 12-15pt ต่อ row
        // สำหรับ font size 11: ประมาณ 13-16pt ต่อ row
        const defaultRowHeight = 14; // pt
        const headerRowHeight = 20; // pt (header มี margin และ bold)
        
        // คำนวณความสูงของ table
        const tableHeight = (headerRows * headerRowHeight) + (dataRows * defaultRowHeight);
        
        // คำนวณจำนวนหน้าที่ table ใช้
        // หักพื้นที่ header ที่จะแสดงซ้ำในแต่ละหน้า
        const headerHeight = headerRows * headerRowHeight;
        const availableHeightForData = availableHeight - headerHeight;
        const estimatedPages = Math.max(1, Math.ceil((dataRows * defaultRowHeight) / availableHeightForData));
        
        // ถ้า table ใช้หลายหน้า ให้เพิ่ม currentPageNumber
        if (estimatedPages > 1) {
          currentPageNumber += estimatedPages - 1;
  }
      }
    }
    
    return coverPageNumbers;
  };

  return {
    header: function (currentPage, pageCount, pageSize) {
      // วิธีที่ 1: ตรวจสอบว่าเป็นหน้าแรกของแต่ละ group หรือไม่
      // สำหรับ group แรก: cover page อยู่หน้า 1
      if (currentPage === 1 && coverPageContentIndexes.includes(0)) {
        return null;
      }
      
      // วิธีที่ 2: ใช้ closure เพื่อคำนวณเลขหน้าของ cover page
      // โดยคำนวณจาก content array, pageBreak, และประมาณการจำนวนหน้าที่ table ใช้
      // ใช้ pageSize และ pageMargins เพื่อคำนวณพื้นที่ที่ใช้ได้
      const calculatedCoverPageNumbers = calculateCoverPageNumbers(pageSize, pageMargins);
      if (calculatedCoverPageNumbers.has(currentPage)) {
        return null;
      }
      
      // วิธีที่ 3: ใช้ coverPageInfo เพื่อตรวจสอบว่าเป็น cover page หรือไม่
      // โดยคำนวณเลขหน้าจาก content items ก่อนหน้า
      for (const coverInfo of coverPageInfo) {
        // ถ้า cover page มี pageBreak: 'before' และเป็นหน้าแรกหลังจาก pageBreak
        // เราต้องคำนวณเลขหน้าจาก content items ก่อนหน้า
        if (coverInfo.hasPageBreakBefore) {
          // คำนวณเลขหน้าจาก content items ก่อนหน้า
          let pageBeforeCover = 1;
          const availableHeight = pageSize.height - pageMargins[1] - pageMargins[3];
          const defaultRowHeight = 14;
          const headerRowHeight = 20;
          
          for (let i = 0; i < coverInfo.contentIndex; i++) {
            const item = content[i];
            if (item.pageBreak === 'before' || (item.table && item.table.pageBreak === 'before')) {
              pageBeforeCover += 1;
            }
            // ถ้าเป็น table อาจใช้หลายหน้า
            if (item.table && item.table.body) {
              const tableRows = item.table.body.length;
              const headerRows = item.table.headerRows || 0;
              const dataRows = tableRows - headerRows;
              const headerHeight = headerRows * headerRowHeight;
              const availableHeightForData = availableHeight - headerHeight;
              const estimatedPages = Math.max(1, Math.ceil((dataRows * defaultRowHeight) / availableHeightForData));
              if (estimatedPages > 1) {
                pageBeforeCover += estimatedPages - 1;
              }
            }
          }
          // cover page จะอยู่หน้าถัดไปหลังจาก pageBreak
          if (currentPage === pageBeforeCover + 1) {
            return null;
          }
        }
      }
      
      // วิธีที่ 4: ใช้ custom property เพื่อตรวจสอบว่าเป็น cover page หรือไม่
      // โดยดูจาก content structure และ currentPage
      // แต่เนื่องจากเราไม่สามารถเข้าถึง content item โดยตรงจาก header function ได้
      // เราจะใช้วิธีอื่นแทน
      
      // ถ้าไม่ใช่ cover page ให้แสดง "แบบ ผ.02"
      return { text: 'แบบ ผ.02', alignment: 'right', fontSize: 11, margin: [0, 40, 20, 0] };
    },
    content,
    pageSize: 'A4',
    pageOrientation,
    pageMargins: [15, 60, 15, 20],
    defaultStyle: { font: 'THSarabun', fontSize: 10 },
    styles: { 
      tableHeader: { alignment: 'center', bold: true, fontSize: 11 },
      tableHeader2: { alignment: 'center', bold: true, fontSize: 10 }

     },
  };
};
