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
 * Cover-page rendering for the supplement title is owned by
 * `report-supplement-cover.part.ts`. This file only renders the per-strategy
 * group cover sheets + the per-project detail tables.
 */

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { SupplementDetailDocParams } from './report.types';

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

const buildAttachmentLine = (project: any, newWord: (t: string) => any) => {
  const attachments: Array<{ originalName?: string | null; filename?: string | null }> =
    Array.isArray(project.attachments) ? project.attachments : [];
  if (attachments.length === 0) return null;

  const names = attachments
    .map(a => a?.originalName || a?.filename || '')
    .filter(n => !!n);
  if (names.length === 0) return null;

  const joined = names.join(', ');
  return {
    text: newWord(`เอกสารแนบ (${names.length} รายการ): ${joined}`),
    font: 'THSarabun',
    fontSize: 9,
    color: '#666',
    italics: true,
    margin: [4, 2, 4, 6],
  };
};

/**
 * Per-group cover page (strategy header). Lightweight intra-document cover
 * that prefixes each strategy block. Distinct from the supplement-wide
 * cover page in `report-supplement-cover.part.ts`.
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
    tacticName: string;
    planName: string;
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
    strategyName,
    tacticName,
    planName,
    pageOffset = 0,
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

  // Attachment-filename line per project (Q7=B). Rendered beneath the table.
  groupProjects.forEach(project => {
    const attachmentLine = buildAttachmentLine(project, newWord);
    if (attachmentLine) {
      content.push({
        // Compose a single inline-text array. `attachmentLine.text` is the
        // word-cut output of `newWord` (an array of inline runs); spreading
        // keeps the inline structure flat for pdfmake.
        text: [
          { text: `[${project.title || '-'}] `, fontSize: 9, color: '#888', italics: true },
          ...(Array.isArray(attachmentLine.text) ? attachmentLine.text : [attachmentLine.text]),
        ],
        margin: attachmentLine.margin,
        fontSize: attachmentLine.fontSize,
        color: attachmentLine.color,
        italics: attachmentLine.italics,
      });
    }
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

/**
 * One-shot whole-supplement detail page builder. Groups internally by
 * Strategy → Tactic → Plan and renders consecutive grouped tables in one
 * document definition. Mirrors `createRevisionEditDetailDocDefinition`'s
 * single-builder ergonomics for callers that don't drive per-group
 * iteration externally.
 */
export const createSupplementDetailDocDefinition = (
  params: SupplementDetailDocParams,
): TDocumentDefinitions | null => {
  const { projects, pageOffset = 0 } = params;
  if (!projects || projects.length === 0) return null;

  // Group by Strategy → Tactic → Plan, preserving caller-supplied order.
  const groupedProjects = new Map<string, any[]>();
  for (const project of projects) {
    const strategyName = project.strategy?.name || '-';
    const tacticName = project.tactic?.name || '-';
    const planName = project.plan?.name || '-';
    const groupKey = `${strategyName}||${tacticName}||${planName}`;
    if (!groupedProjects.has(groupKey)) groupedProjects.set(groupKey, []);
    groupedProjects.get(groupKey)!.push(project);
  }

  // Build a synthetic per-group doc for the first group; subsequent groups
  // append their content into the same definition via pageBreak: 'before'.
  // For simplicity we generate a multi-group doc by concatenating content
  // arrays from per-group builders.
  const docDefs: TDocumentDefinitions[] = [];
  for (const [groupKey, groupProjects] of groupedProjects.entries()) {
    const [strategyName, tacticName, planName] = groupKey.split('||');
    const groupDoc = createSupplementGroupDetailDocDefinition({
      ...params,
      groupProjects,
      strategyName,
      tacticName,
      planName,
      pageOffset,
    });
    if (groupDoc) docDefs.push(groupDoc);
  }

  if (docDefs.length === 0) return null;

  // Concatenate. Each subsequent group's first block gets a page break.
  const mergedContent: any[] = [];
  docDefs.forEach((doc, idx) => {
    const docContent = Array.isArray(doc.content) ? doc.content : [doc.content];
    if (idx > 0 && docContent.length > 0) {
      const first = { ...(docContent[0] as any), pageBreak: 'before' };
      mergedContent.push(first, ...docContent.slice(1));
    } else {
      mergedContent.push(...docContent);
    }
  });

  const first = docDefs[0];
  return {
    header: first.header,
    footer: first.footer,
    content: mergedContent,
    pageSize: first.pageSize,
    pageOrientation: first.pageOrientation,
    pageMargins: first.pageMargins,
    defaultStyle: first.defaultStyle,
    styles: first.styles,
  };
};
