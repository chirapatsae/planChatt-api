import type { TDocumentDefinitions } from 'pdfmake/interfaces';
// BE-REV-01 — STRATEGY_BASED external alignment block (4 rows) injected
// below the Strategy/Tactic/Plan stack and above the column headers.
// Shared with main-plan renderer (BE-MAIN-01); revision/change PDFs
// reuse the identical row builder. See PDF_EXTERNAL_ALIGNMENT_BE_REV.md.
import { buildExternalAlignmentRows } from './report-external-alignment.part';
import type { AlignmentRow } from 'src/project-alignment-mapping/types/alignment.types';

// Helper function เพื่อตรวจสอบว่าค่ามีการเปลี่ยนแปลงหรือไม่
const hasChanged = (oldValue: any, newValue: any): boolean => {
  if (oldValue === null || oldValue === undefined) {
    return newValue !== null && newValue !== undefined;
  }
  if (newValue === null || newValue === undefined) {
    return true;
  }
  // สำหรับ string
  if (typeof oldValue === 'string' && typeof newValue === 'string') {
    return oldValue.trim() !== newValue.trim();
  }
  // สำหรับ number
  if (typeof oldValue === 'number' && typeof newValue === 'number') {
    return oldValue !== newValue;
  }
  // สำหรับ array (budgets)
  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    if (oldValue.length !== newValue.length) return true;
    // เปรียบเทียบแต่ละ budget
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

export interface RevisionEditDetailDocParams {
  developmentPlanRevisionName: string;
  years: number[];
  projects: Array<{
    current: any; // RevisedProjectGroup (current)
    previous: any; // ProjectGroup | RevisedProjectGroup | null (previous)
    oldAdditionDetail?: string | null;
    additionalDetail?: string | null;
  }>;
  availableColumns: string[];
  columnMap: Record<string, { text: string; key: string }>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
  reportType?: string;
  pageOffset?: number; // offset สำหรับเลขหน้า
}

// สร้าง cover page สำหรับแต่ละ group (ไม่มี header "แบบ ผ.02")
export const createRevisionEditGroupCoverPageDocDefinition = (
  strategyName: string,
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
      return null; // ไม่แสดง header ใน cover page
    },
    footer: function (currentPage: number, pageCount: number) {
      const footerText = newWord ? newWord(developmentPlanRevisionName) : developmentPlanRevisionName;
      const pageNumber = currentPage + pageOffset;
      return {
        columns: [
          { text: '', width: '*' }, // dummy ซ้าย
          // ตรงกลาง (ชื่อแผนแก้ไข)
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
export const createRevisionEditGroupDetailDocDefinition = (
  params: Omit<RevisionEditDetailDocParams, 'projects'> & {
    groupProjects: Array<{
      current: any;
      previous: any;
      oldAdditionDetail?: string | null;
      additionalDetail?: string | null;
    }>;
    strategyName: string;
    /** Strategy code (e.g. STRAT001) — drives ordinal in จ. row */
    strategyCode?: string | null;
    tacticName: string;
    planName: string;
    pageOffset?: number;
    // Resolved external alignment for THIS (strategy, tactic, plan)
    // group; `null` when the resolver returned no mapping.
    alignment?: AlignmentRow | null;
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
    strategyName,
    strategyCode = null,
    tacticName,
    planName,
    pageOffset = 0,
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

  // Helper function เพื่อสร้าง table สำหรับโครงการเดิม (oldAdditionDetail + previous)
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
    pageBreakBefore: boolean = false, // เพิ่ม parameter สำหรับ pageBreakBefore
  ) => {
    const { previous, oldAdditionDetail } = project;
    if (!previous && !oldAdditionDetail) {
      return null;
    }

    const totalColumns = groupColumns.length + (groupColumns.includes('budget') ? years.length - 1 : 0);
    const tableBody: any[] = [];

    // แถวที่ 1: oldAdditionDetail (colspan ทั้งแถว)
    if (oldAdditionDetail) {
      tableBody.push([
        {
          colSpan: totalColumns,
          text: newWord(oldAdditionDetail),
          font: 'THSarabun',
          fontSize: 10,
          bold: true,
          border: [true, false, true, false], // แสดงเส้นขอบซ้ายและขวา
          margin: [5, 2, 5, 2],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
      ]);
    }

    // แถวที่ 2: รายละเอียดโครงการเดิม (previous)
    if (previous) {
      const oldRow: any[] = [];
      groupColumns.forEach(col => {
        switch (col) {
          case 'index':
            oldRow.push({ text: String(projectIndex), alignment: 'center' });
            break;
          case 'title':
            oldRow.push({ text: newWord(previous.title || '-'), font: 'THSarabun' });
            break;
          case 'objective':
            oldRow.push({ text: newWord(previous.objective || '-'), font: 'THSarabun' });
            break;
          case 'target':
            oldRow.push({ text: newWord(previous.goal || '-'), font: 'THSarabun' });
            break;
          case 'budget':
            oldRow.push(...years.map(year => {
              const match = previous.budgets?.find((b: any) => b.year === year);
              const value = match ? parseFloat(match.quantity) : NaN;
              return { text: isNaN(value) ? '' : value.toLocaleString('th-TH'), alignment: 'right' };
            }));
            break;
          case 'kpi':
            oldRow.push({ text: newWord(previous.indicator || '-'), font: 'THSarabun' });
            break;
          case 'expectedResult':
            oldRow.push({ text: newWord(previous.expected || '-'), font: 'THSarabun' });
            break;
          case 'mainAgency':
            {
              const agencyName = reportType !== 'inAuthority'
                ? 'ยังไม่ระบุ'
                : previous.responsibleAgency?.name;
              oldRow.push({ text: newWord(agencyName || '-'), font: 'THSarabun', alignment: 'center' });
            }
            break;
          case 'amphoe':
            {
              const hasOriginAgency = previous.originAgencyId || previous.originAgency;
              if (hasOriginAgency) {
                const amphoeName = previous.originAgencyId?.amphoe?.name
                  || previous.originAgency?.amphoe?.name
                  || previous.amphoe?.name
                  || '-';
                oldRow.push({ text: newWord(amphoeName), font: 'THSarabun', alignment: 'center' });
              } else {
                oldRow.push({ text: '-', font: 'THSarabun', alignment: 'center' });
              }
            }
            break;
          case 'coordinates':
            {
              const hasOriginAgency = previous.originAgencyId || previous.originAgency;
              if (hasOriginAgency) {
                const startLat = previous.startLat != null ? Number(previous.startLat) : null;
                const startLng = previous.startLng != null ? Number(previous.startLng) : null;
                const endLat = previous.endLat != null ? Number(previous.endLat) : null;
                const endLng = previous.endLng != null ? Number(previous.endLng) : null;

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
                oldRow.push({
                  text: newWord(coordText),
                  font: 'THSarabun',
                  alignment: 'left',
                  fontSize: 9,
                  margin: [2, 2, 2, 2]
                });
              } else {
                oldRow.push({ text: '-', font: 'THSarabun', alignment: 'center' });
              }
            }
            break;
          default:
            oldRow.push({ text: '', alignment: 'center' });
        }
      });
      tableBody.push(oldRow);
    }

    // สร้าง header rows
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

    // QA-PDF-ALIGN-02 (2026-05-19) — header band order (top → bottom):
    //   5 external alignment rows (ก. ข. ค. ง. จ.)
    // → 1 Strategy/Tactic/Plan stack row
    // → 2 column-header rows (headerRow1, headerRow2)
    // = 8 rows total when showHeader=true.
    if (showHeader) {
      const alignmentRows = buildExternalAlignmentRows(
        alignment,
        { code: strategyCode, name: strategyName },
        totalColumns,
      );
      const stpStackRow = [
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
      ];
      tableBody.unshift(
        ...alignmentRows,
        stpStackRow,
        headerRow1,
        headerRow2,
      );
    } else {
      tableBody.unshift(headerRow1, headerRow2);
    }

    const columnWidths = calculateColumnWidths(groupColumns, years);
    // QA-PDF-ALIGN-02 (2026-05-19): headerRows = 8 = 5 alignment + 1 STP
    // stack + 2 column headers. showHeader=false continuation pages
    // keep 2 (column headers only).
    const headerRows = showHeader ? 8 : 2;

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
        vLineColor: () => '#000'
      },
      pageBreak: pageBreakBefore ? 'before' : undefined, // เพิ่ม pageBreakBefore ถ้าต้องการ
    };
  };

  // Helper functions
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

  // เพิ่มข้อความ "รายละเอียดโครงการ..." ในหน้าแรกของ detail page
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

  // Helper function เพื่อสร้าง table สำหรับโครงการใหม่ (additionalDetail + current)
  const createTableForNewProject = (
    project: {
      current: any;
      previous: any;
      oldAdditionDetail?: string | null;
      additionalDetail?: string | null;
    },
    projectIndex: number,
    groupColumns: string[],
    showHeader: boolean = false,
    isLastTable: boolean = false,
    groupSumByYear?: Record<number, number>,
    groupCountByYear?: Record<number, number>,
  ) => {
    const { current, previous, additionalDetail } = project;
    const totalColumns = groupColumns.length + (groupColumns.includes('budget') ? years.length - 1 : 0);
    const tableBody: any[] = [];

    // แถวที่ 1: additionalDetail (colspan ทั้งแถว)
    if (additionalDetail) {
      tableBody.push([
        {
          colSpan: totalColumns,
          text: newWord(additionalDetail),
          font: 'THSarabun',
          fontSize: 10,
          bold: true,
          border: [true, false, true, false], // แสดงเส้นขอบซ้ายและขวา
          margin: [5, 2, 5, 2],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
      ]);
    }

    // แถวที่ 2: รายละเอียดโครงการใหม่ (current) - คอลัมน์ที่มีการเปลี่ยนแปลงให้ทำตัวหนา
    const newRow: any[] = [];
    groupColumns.forEach(col => {
      const isChanged = previous ? (() => {
        switch (col) {
          case 'title':
            return hasChanged(previous.title, current.title);
          case 'objective':
            return hasChanged(previous.objective, current.objective);
          case 'target':
            return hasChanged(previous.goal, current.goal);
          case 'budget':
            return hasChanged(previous.budgets, current.budgets);
          case 'kpi':
            return hasChanged(previous.indicator, current.indicator);
          case 'expectedResult':
            return hasChanged(previous.expected, current.expected);
          case 'mainAgency':
            return hasChanged(previous.responsibleAgency?.name, current.responsibleAgency?.name);
          case 'amphoe':
            const prevAmphoe = previous.originAgencyId?.amphoe?.name
              || previous.originAgency?.amphoe?.name
              || previous.amphoe?.name;

            const currAmphoe = current.originAgencyId?.amphoe?.name
              || current.originAgency?.amphoe?.name
              || current.amphoe?.name;

            return hasChanged(prevAmphoe, currAmphoe);
          case 'coordinates':
            return hasChanged(
              { startLat: previous.startLat, startLng: previous.startLng, endLat: previous.endLat, endLng: previous.endLng },
              { startLat: current.startLat, startLng: current.startLng, endLat: current.endLat, endLng: current.endLng }
            );
          default:
            return false;
        }
      })() : false;

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
              ...(budgetChanged ? { bold: true } : {})
            };
          }));
          break;
        case 'kpi':
          newRow.push({ text: newWord(current.indicator || '-'), font: 'THSarabun', ...cellStyle });
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
            const hasOriginAgency = current.originAgencyId || current.originAgency;
            if (hasOriginAgency) {
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
            const hasOriginAgency = current.originAgencyId || current.originAgency;
            if (hasOriginAgency) {
              const startLat = current.startLat != null ? Number(current.startLat) : null;
              const startLng = current.startLng != null ? Number(current.startLng) : null;
              const endLat = current.endLat != null ? Number(current.endLat) : null;
              const endLng = current.endLng != null ? Number(current.endLng) : null;

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
              newRow.push({
                text: newWord(coordText),
                font: 'THSarabun',
                alignment: 'left',
                fontSize: 9,
                margin: [2, 2, 2, 2],
                ...cellStyle
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

    // สร้าง header rows
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
    
    tableBody.unshift(headerRow1, headerRow2);

    // แสดง summary rows เฉพาะเมื่อเป็น table สุดท้ายของ group
    if (isLastTable) {
      const finalSumByYear = groupSumByYear || {};
      const finalCountByYear = groupCountByYear || {};

      if (groupColumns.includes('budget')) {
        const budgetColumnIndex = groupColumns.indexOf('budget');
        const columnsBeforeBudget = budgetColumnIndex > 0 ? groupColumns.slice(0, budgetColumnIndex) : [];
        const columnsAfterBudget = groupColumns.slice(budgetColumnIndex + 1);
        const summaryLabelColSpan = columnsBeforeBudget.length;

        const summaryRow: any[] = [];
        if (summaryLabelColSpan > 0) {
          // pushSpannedCells helper function
          if (summaryLabelColSpan > 1) {
            summaryRow.push({ text: 'รวมงบประมาณ', alignment: 'center', bold: true, colSpan: summaryLabelColSpan });
            for (let i = 1; i < summaryLabelColSpan; i += 1) {
              summaryRow.push({ text: '' });
            }
          } else {
            summaryRow.push({ text: 'รวมงบประมาณ', alignment: 'center', bold: true });
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

        const countSummaryRow: any[] = [];
        if (summaryLabelColSpan > 0) {
          if (summaryLabelColSpan > 1) {
            countSummaryRow.push({ text: 'รวมจำนวนโครงการ', alignment: 'right', bold: true, colSpan: summaryLabelColSpan });
            for (let i = 1; i < summaryLabelColSpan; i += 1) {
              countSummaryRow.push({ text: '' });
            }
          } else {
            countSummaryRow.push({ text: 'รวมจำนวนโครงการ', alignment: 'right', bold: true });
          }
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
        vLineColor: () => '#000'
      },
      pageBreak: previous ? 'before' : undefined, // ถ้ามี previous ให้มี pageBreakBefore
    };
  };

  // คำนวณ sumByYear และ countByYear ของทั้ง group จาก current.budgets
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

  // สร้าง table สำหรับแต่ละโครงการ
  let projectIndex = 1;
  for (let i = 0; i < groupProjects.length; i++) {
    const project = groupProjects[i];
    const currentHasOriginAgency = hasOriginAgency(project.current);
    const cols = createAvailableColumns(currentHasOriginAgency);
    const showHeader = i === 0; // แสดง header เฉพาะโครงการแรกของแต่ละ group

    // เช็คว่าถ้าโครงการก่อนหน้ามี previous (คือมีโครงการเดิม) ให้เพิ่ม pageBreakBefore ให้กับโครงการเดิมของโครงการปัจจุบัน
    // เพื่อป้องกันไม่ให้โครงการเดิมของโครงการถัดไปแสดงต่อโครงการใหม่ของโครงการก่อนหน้า
    const prevProject = i > 0 ? groupProjects[i - 1] : null;
    const shouldPageBreakOld = prevProject && prevProject.previous && project.previous;

    // สร้าง table สำหรับโครงการเดิม (ถ้ามี)
    const oldTable = createTableForOldProject(
      project,
      projectIndex,
      cols,
      showHeader,
      shouldPageBreakOld // เพิ่ม pageBreakBefore ถ้าต้องการ
    );
    
    if (oldTable) {
      content.push(oldTable);
    }

    // สร้าง table สำหรับโครงการใหม่ (มี pageBreakBefore ถ้ามี previous)
    const isLastTable = i === groupProjects.length - 1; // เช็คว่าเป็น table สุดท้ายของ group หรือไม่
    const newTable = createTableForNewProject(
      project,
      projectIndex++,
      cols,
      false, // ไม่ต้องแสดง header เพราะแสดงไปแล้วใน oldTable
      isLastTable, // ส่ง flag ว่าเป็น table สุดท้ายหรือไม่
      groupSumByYear, // ส่งผลรวมของทั้ง group
      groupCountByYear // ส่งจำนวนโครงการของทั้ง group
    );
    
    if (newTable) {
      content.push(newTable);
    }
  }

  return {
    header: function () {
      return { text: 'แบบ ผ.02', alignment: 'right', fontSize: 11, margin: [0, 40, 20, 0] };
    },
    footer: function (currentPage: number, pageCount: number) {
      const footerText = newWord ? newWord(developmentPlanRevisionName) : developmentPlanRevisionName;
      const pageNumber = currentPage + pageOffset;
      return {
        columns: [
          { text: '', width: '*' }, // dummy ซ้าย
          // ตรงกลาง (ชื่อแผนแก้ไข)
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

// สร้าง detail page สำหรับ revision edit draft
export const createRevisionEditDetailDocDefinition = (
  params: RevisionEditDetailDocParams,
): TDocumentDefinitions | null => {
  const {
    developmentPlanRevisionName,
    years,
    projects,
    availableColumns,
    columnMap,
    pageMargins,
    pageOrientation,
    newWord,
    reportType = 'default',
  } = params;

  if (projects.length === 0) {
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

  // Helper function เพื่อสร้าง table สำหรับโครงการเดียว (4 แถว)
  const createTableForSingleProject = (
    project: {
      current: any;
      previous: any;
      oldAdditionDetail?: string | null;
      additionalDetail?: string | null;
    },
    projectIndex: number,
    groupColumns: string[],
    strategyName: string,
    tacticName: string,
    planName: string,
    showHeader: boolean = true,
  ) => {
    const { current, previous, oldAdditionDetail, additionalDetail } = project;
    const totalColumns = groupColumns.length + (groupColumns.includes('budget') ? years.length - 1 : 0);
    const tableBody: any[] = [];

    // แถวที่ 1: oldAdditionDetail (colspan ทั้งแถว)
    if (oldAdditionDetail) {
      tableBody.push([
        {
          colSpan: totalColumns,
          text: newWord(oldAdditionDetail),
          font: 'THSarabun',
          fontSize: 10,
          bold: true,
          border: [true, false, true, false], // แสดงเส้นขอบซ้ายและขวา
          margin: [5, 2, 5, 2],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
      ]);
    }

    // แถวที่ 2: รายละเอียดโครงการเดิม (previous)
    if (previous) {
      const oldRow: any[] = [];
      groupColumns.forEach(col => {
        switch (col) {
          case 'index':
            oldRow.push({ text: String(projectIndex), alignment: 'center' });
            break;
          case 'title':
            oldRow.push({ text: newWord(previous.title || '-'), font: 'THSarabun' });
            break;
          case 'objective':
            oldRow.push({ text: newWord(previous.objective || '-'), font: 'THSarabun' });
            break;
          case 'target':
            oldRow.push({ text: newWord(previous.goal || '-'), font: 'THSarabun' });
            break;
          case 'budget':
            oldRow.push(...years.map(year => {
              const match = previous.budgets?.find((b: any) => b.year === year);
              const value = match ? parseFloat(match.quantity) : NaN;
              return { text: isNaN(value) ? '' : value.toLocaleString('th-TH'), alignment: 'right' };
            }));
            break;
          case 'kpi':
            oldRow.push({ text: newWord(previous.indicator || '-'), font: 'THSarabun' });
            break;
          case 'expectedResult':
            oldRow.push({ text: newWord(previous.expected || '-'), font: 'THSarabun' });
            break;
          case 'mainAgency':
            {
              const agencyName = reportType !== 'inAuthority'
                ? 'ยังไม่ระบุ'
                : previous.responsibleAgency?.name;
              oldRow.push({ text: newWord(agencyName || '-'), font: 'THSarabun', alignment: 'center' });
            }
            break;
          case 'amphoe':
            {
              const hasOriginAgency = previous.originAgencyId || previous.originAgency;
              if (hasOriginAgency) {
                const amphoeName = previous.originAgencyId?.amphoe?.name
                  || previous.originAgency?.amphoe?.name
                  || previous.amphoe?.name
                  || '-';
                oldRow.push({ text: newWord(amphoeName), font: 'THSarabun', alignment: 'center' });
              } else {
                oldRow.push({ text: '-', font: 'THSarabun', alignment: 'center' });
              }
            }
            break;
          case 'coordinates':
            {
              const hasOriginAgency = previous.originAgencyId || previous.originAgency;
              if (hasOriginAgency) {
                const startLat = previous.startLat != null ? Number(previous.startLat) : null;
                const startLng = previous.startLng != null ? Number(previous.startLng) : null;
                const endLat = previous.endLat != null ? Number(previous.endLat) : null;
                const endLng = previous.endLng != null ? Number(previous.endLng) : null;

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
                oldRow.push({
                  text: newWord(coordText),
                  font: 'THSarabun',
                  alignment: 'left',
                  fontSize: 9,
                  margin: [2, 2, 2, 2]
                });
              } else {
                oldRow.push({ text: '-', font: 'THSarabun', alignment: 'center' });
              }
            }
            break;
          default:
            oldRow.push({ text: '', alignment: 'center' });
        }
      });
      tableBody.push(oldRow);
    }

    // แถวที่ 3: additionalDetail (colspan ทั้งแถว)
    if (additionalDetail) {
      tableBody.push([
        {
          colSpan: totalColumns,
          text: newWord(additionalDetail),
          font: 'THSarabun',
          fontSize: 10,
          bold: true,
          border: [true, false, true, false], // แสดงเส้นขอบซ้ายและขวา
          margin: [5, 2, 5, 2],
        },
        ...Array.from({ length: totalColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
      ]);
    }

    // แถวที่ 4: รายละเอียดโครงการใหม่ (current) - คอลัมน์ที่มีการเปลี่ยนแปลงให้ทำตัวหนา
    const newRow: any[] = [];
    groupColumns.forEach(col => {
      const isChanged = previous ? (() => {
        switch (col) {
          case 'title':
            return hasChanged(previous.title, current.title);
          case 'objective':
            return hasChanged(previous.objective, current.objective);
          case 'target':
            return hasChanged(previous.goal, current.goal);
          case 'budget':
            return hasChanged(previous.budgets, current.budgets);
          case 'kpi':
            return hasChanged(previous.indicator, current.indicator);
          case 'expectedResult':
            return hasChanged(previous.expected, current.expected);
          case 'mainAgency':
            return hasChanged(previous.responsibleAgency?.name, current.responsibleAgency?.name);
          case 'amphoe':
            const prevAmphoe = previous.originAgencyId?.amphoe?.name
              || previous.originAgency?.amphoe?.name
              || previous.amphoe?.name;

            const currAmphoe = current.originAgencyId?.amphoe?.name
              || current.originAgency?.amphoe?.name
              || current.amphoe?.name;

            return hasChanged(prevAmphoe, currAmphoe);
          case 'coordinates':
            return hasChanged(
              { startLat: previous.startLat, startLng: previous.startLng, endLat: previous.endLat, endLng: previous.endLng },
              { startLat: current.startLat, startLng: current.startLng, endLat: current.endLat, endLng: current.endLng }
            );
          default:
            return false;
        }
      })() : false;

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
              ...(budgetChanged ? { bold: true } : {})
            };
          }));
          break;
        case 'kpi':
          newRow.push({ text: newWord(current.indicator || '-'), font: 'THSarabun', ...cellStyle });
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
            const hasOriginAgency = current.originAgencyId || current.originAgency;
            if (hasOriginAgency) {
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
            const hasOriginAgency = current.originAgencyId || current.originAgency;
            if (hasOriginAgency) {
              const startLat = current.startLat != null ? Number(current.startLat) : null;
              const startLng = current.startLng != null ? Number(current.startLng) : null;
              const endLat = current.endLat != null ? Number(current.endLat) : null;
              const endLng = current.endLng != null ? Number(current.endLng) : null;

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
              newRow.push({
                text: newWord(coordText),
                font: 'THSarabun',
                alignment: 'left',
                fontSize: 9,
                margin: [2, 2, 2, 2],
                ...cellStyle
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

    // สร้าง header rows
    const headerRow1: any[] = [];
    const headerRow2: any[] = [];
    
    if (showHeader) {
      // แถวหัวตาราง "ยุทธศาสตร์ กลยุทธ์ แผนงาน"
      tableBody.unshift([
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
    }

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
        vLineColor: () => '#000'
      },
      pageBreak: 'before', // ขึ้นหน้าใหม่สำหรับแต่ละโครงการ
    };
  };

  // Helper functions
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

  // เพิ่มข้อความ "รายละเอียดโครงการ..." ในหน้าแรก
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

  // Group projects by strategy, tactic, plan
  const groupedProjects = new Map<string, typeof projects>();
  for (const project of projects) {
    const current = project.current;
    const strategyName = current.strategy?.name || '-';
    const tacticName = current.tactic?.name || '-';
    const planName = current.plan?.name || '-';
    const groupKey = `${strategyName}||${tacticName}||${planName}`;

    if (!groupedProjects.has(groupKey)) {
      groupedProjects.set(groupKey, []);
    }
    groupedProjects.get(groupKey)!.push(project);
  }

  // สร้าง table สำหรับแต่ละโครงการ
  let projectIndex = 1;
  for (const [groupKey, groupProjects] of groupedProjects.entries()) {
    const [strategyName, tacticName, planName] = groupKey.split('||');
    
    for (let i = 0; i < groupProjects.length; i++) {
      const project = groupProjects[i];
      const currentHasOriginAgency = hasOriginAgency(project.current);
      const cols = createAvailableColumns(currentHasOriginAgency);
      const showHeader = i === 0; // แสดง header เฉพาะโครงการแรกของแต่ละ group

      const table = createTableForSingleProject(
        project,
        projectIndex++,
        cols,
        strategyName,
        tacticName,
        planName,
        showHeader
      );
      
      if (table) {
        content.push(table);
      }
    }
  }

  return {
    header: function () {
      return { text: 'แบบ ผ.02', alignment: 'right', fontSize: 11, margin: [0, 40, 20, 0] };
    },
    footer: function (currentPage: number, pageCount: number) {
      const footerText = newWord ? newWord(developmentPlanRevisionName) : developmentPlanRevisionName;
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
            text: String(currentPage),
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

