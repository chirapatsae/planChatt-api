/**
 * SUPP_PRINT_BE_02 — Supplement summary page (format-aware).
 *
 * Renders the supplement's top-level summary table:
 *   - Total approved project count
 *   - Total budget across all years (BE-aggregated by `Budget.year`)
 *   - Per-year budget breakdown table
 *
 * The summary branches on the parent plan's `reportFormat` (§16.3):
 *   - STRATEGY_BASED → Strategy → Plan tree (mirrors `report-summary.part.ts`)
 *   - ISSUE_BASED    → Flat list of DevelopmentIssue rows
 *                      (mirrors `report-summary-issue-based.part.ts`)
 *
 * The summary page does NOT carry the supplement-wide cover label
 * (`เล่มเพิ่มเติมรอบที่ N พ.ศ. ...`) — that responsibility lives in
 * `report-supplement-cover.part.ts`. The summary leads with an intra-doc
 * "บัญชีสรุปโครงการพัฒนา" heading consistent with the existing main-plan
 * and revision summary pages.
 */

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type {
  SupplementSummaryDocParams,
  StrategySummary,
  PlanSummary,
  IssueSummary,
} from './report.types';

const renderStrategyBasedSummary = (params: SupplementSummaryDocParams): TDocumentDefinitions => {
  const {
    developmentPlanSupplementName,
    years,
    strategies,
    overallSum,
    overallCount,
    totalProjectCount,
    pageMargins,
    pageOrientation,
    newWord,
  } = params;

  if (!strategies) {
    throw new Error(
      'report-supplement-summary STRATEGY_BASED branch requires `strategies` aggregation; missing input.',
    );
  }

  const content: any[] = [];

  // Intra-doc heading.
  content.push({
    stack: [
      'บัญชีสรุปโครงการพัฒนา \n',
      developmentPlanSupplementName + '\n',
      'องค์การบริหารส่วนจังหวัดนครราชสีมา\n',
    ],
    alignment: 'center',
    bold: true,
    margin: [0, 10, 0, 0],
    fontSize: 12,
  });

  // Top-level total summary line (per user spec).
  const overallTotalSum = years.reduce((sum, y) => sum + (overallSum[y] || 0), 0);
  content.push({
    text: `จำนวนโครงการอนุมัติทั้งสิ้น ${totalProjectCount} โครงการ  |  งบประมาณรวม ${overallTotalSum.toLocaleString('th-TH')} บาท`,
    alignment: 'center',
    fontSize: 13,
    bold: true,
    margin: [0, 6, 0, 14],
  });

  // Per-year + summary table.
  const summaryTableBody: any[] = [];
  const summaryDataColumns = years.length * 2 + 2;
  const totalSummaryColumns = 1 + summaryDataColumns;

  const headerRow1: any[] = [
    { text: 'ยุทธศาสตร์ ', rowSpan: 2, style: 'tableHeader', alignment: 'center', margin: [0, 20, 0, 0] },
  ];
  for (const year of years) {
    headerRow1.push({
      text: `ปี ${year}`,
      colSpan: 2,
      style: 'tableHeader',
      alignment: 'center',
      bold: true,
    });
    headerRow1.push({ text: '', style: 'tableHeader' });
  }
  headerRow1.push({
    text: `รวม ${years.length} ปี`,
    colSpan: 2,
    style: 'tableHeader',
    alignment: 'center',
    bold: true,
  });
  headerRow1.push({ text: '', style: 'tableHeader' });
  summaryTableBody.push(headerRow1);

  const headerRow2: any[] = [{ text: '', style: 'tableHeader' }];
  for (const _ of years) {
    headerRow2.push({ text: newWord('จำนวน\n โครงการ'), style: 'tableHeader', alignment: 'center', bold: true });
    headerRow2.push({ text: newWord('งบประมาณ\n (บาท)'), style: 'tableHeader', alignment: 'center', bold: true });
  }
  headerRow2.push({ text: newWord('จำนวน\n โครงการ'), style: 'tableHeader', alignment: 'center', bold: true });
  headerRow2.push({ text: newWord('งบรวม  \n (บาท)'), style: 'tableHeader', alignment: 'center', bold: true });
  summaryTableBody.push(headerRow2);

  for (const strategySummary of strategies.values()) {
    const plansArray: PlanSummary[] = Array.from(strategySummary.plans.values());

    summaryTableBody.push([
      {
        text: `ยุทธศาสตร์: ${strategySummary.strategyName}`,
        colSpan: totalSummaryColumns,
        alignment: 'left',
        bold: true,
      },
      ...Array.from({ length: totalSummaryColumns - 1 }, () => ({ text: '', border: [false, false, false, false] })),
    ]);

    if (plansArray.length === 0) {
      const row: any[] = [];
      row.push({ text: '   (ไม่มีแผนงาน)', italics: true, alignment: 'left' });
      for (const year of years) {
        const count = strategySummary.perYearCount[year] || 0;
        const sum = strategySummary.perYearSum[year] || 0;
        row.push({ text: count ? String(count) : '', alignment: 'center' });
        row.push({ text: sum ? sum.toLocaleString('th-TH') : '', alignment: 'right' });
      }
      const stratTotalCount = years.reduce((sum, year) => sum + (strategySummary.perYearCount[year] || 0), 0);
      const stratTotalSum = years.reduce((sum, year) => sum + (strategySummary.perYearSum[year] || 0), 0);
      row.push({ text: stratTotalCount ? String(stratTotalCount) : '', alignment: 'center' });
      row.push({ text: stratTotalSum ? stratTotalSum.toLocaleString('th-TH') : '', alignment: 'right' });
      summaryTableBody.push(row);
    } else {
      for (const planSummary of plansArray) {
        const row: any[] = [];
        row.push({
          text: newWord(planSummary.planName || '-'),
          alignment: 'left',
          margin: [6, 0, 0, 0],
        });
        let planTotalCount = 0;
        let planTotalSum = 0;
        for (const year of years) {
          const count = planSummary.perYearCount[year] || 0;
          const sum = planSummary.perYearSum[year] || 0;
          planTotalCount += count;
          planTotalSum += sum;
          row.push({ text: count ? String(count) : '', alignment: 'center' });
          row.push({ text: sum ? sum.toLocaleString('th-TH') : '', alignment: 'right' });
        }
        row.push({ text: planTotalCount ? String(planTotalCount) : '', alignment: 'center' });
        row.push({ text: planTotalSum ? planTotalSum.toLocaleString('th-TH') : '', alignment: 'right' });
        summaryTableBody.push(row);
      }
    }

    const strategySummaryRow: any[] = [];
    strategySummaryRow.push({ text: '   รวม', alignment: 'center', bold: true });
    for (const year of years) {
      strategySummaryRow.push({
        text: strategySummary.perYearCount[year] ? String(strategySummary.perYearCount[year]) : '',
        alignment: 'center',
        bold: true,
      });
      strategySummaryRow.push({
        text: strategySummary.perYearSum[year] ? strategySummary.perYearSum[year].toLocaleString('th-TH') : '',
        alignment: 'right',
        bold: true,
      });
    }
    const stratTotalCount = years.reduce((sum, year) => sum + (strategySummary.perYearCount[year] || 0), 0);
    const stratTotalSum = years.reduce((sum, year) => sum + (strategySummary.perYearSum[year] || 0), 0);
    strategySummaryRow.push({ text: stratTotalCount ? String(stratTotalCount) : '', alignment: 'center', bold: true });
    strategySummaryRow.push({ text: stratTotalSum ? stratTotalSum.toLocaleString('th-TH') : '', alignment: 'right', bold: true });
    summaryTableBody.push(strategySummaryRow);
  }

  const overallRow: any[] = [{ text: 'รวมทั้งสิ้น', alignment: 'right', bold: true }];
  for (const year of years) {
    overallRow.push({ text: overallCount[year] ? String(overallCount[year]) : '', alignment: 'center', bold: true });
    overallRow.push({ text: overallSum[year] ? overallSum[year].toLocaleString('th-TH') : '', alignment: 'right', bold: true });
  }
  const overallTotalCount = years.reduce((sum, year) => sum + (overallCount[year] || 0), 0);
  const summaryOverallTotalSum = years.reduce((sum, year) => sum + (overallSum[year] || 0), 0);
  overallRow.push({ text: overallTotalCount ? String(overallTotalCount) : '', alignment: 'center', bold: true });
  overallRow.push({ text: summaryOverallTotalSum ? summaryOverallTotalSum.toLocaleString('th-TH') : '', alignment: 'right', bold: true });
  summaryTableBody.push(overallRow);

  content.push({
    table: {
      headerRows: 2,
      widths: ['*', 30, 61, 30, 61, 30, 61, 30, 61, 30, 61, 30, 61],
      body: summaryTableBody,
    },
    layout: {
      hLineWidth: (i: number) => (i < 2 ? 1.2 : 0.8),
      vLineWidth: () => 0.8,
      hLineColor: () => '#000',
      vLineColor: () => '#000',
    },
  });

  return {
    header: function (currentPage: number) {
      if (currentPage === 1) return null;
      return {
        text: 'แบบ ผ.01',
        alignment: 'right',
        fontSize: 12,
        margin: [0, 40, 20, 0],
      };
    },
    footer: (currentPage) => {
      const footerText = newWord
        ? newWord(developmentPlanSupplementName)
        : developmentPlanSupplementName;
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
            text: String(currentPage),
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
    pageMargins,
    defaultStyle: { font: 'THSarabun', fontSize: 12 },
    styles: {
      tableHeader: { alignment: 'center', bold: true, fontSize: 12 },
    },
  };
};

const renderIssueBasedSummary = (params: SupplementSummaryDocParams): TDocumentDefinitions => {
  const {
    developmentPlanSupplementName,
    years,
    issues,
    overallSum,
    overallCount,
    totalProjectCount,
    pageMargins,
    pageOrientation,
    newWord,
  } = params;

  if (!issues) {
    throw new Error(
      'report-supplement-summary ISSUE_BASED branch requires `issues` aggregation; missing input.',
    );
  }

  const content: any[] = [];

  content.push({
    stack: [
      'บัญชีสรุปโครงการพัฒนา \n',
      developmentPlanSupplementName + '\n',
      'องค์การบริหารส่วนจังหวัดนครราชสีมา\n',
    ],
    alignment: 'center',
    bold: true,
    margin: [0, 10, 0, 0],
    fontSize: 12,
  });

  const overallTotalSum = years.reduce((sum, y) => sum + (overallSum[y] || 0), 0);
  content.push({
    text: `จำนวนโครงการอนุมัติทั้งสิ้น ${totalProjectCount} โครงการ  |  งบประมาณรวม ${overallTotalSum.toLocaleString('th-TH')} บาท`,
    alignment: 'center',
    fontSize: 13,
    bold: true,
    margin: [0, 6, 0, 14],
  });

  const summaryTableBody: any[] = [];

  const headerRow1: any[] = [
    {
      text: 'ประเด็นการพัฒนา',
      rowSpan: 2,
      style: 'tableHeader',
      alignment: 'center',
      margin: [0, 20, 0, 0],
    },
  ];
  for (const year of years) {
    headerRow1.push({
      text: `ปี ${year}`,
      colSpan: 2,
      style: 'tableHeader',
      alignment: 'center',
      bold: true,
    });
    headerRow1.push({ text: '', style: 'tableHeader' });
  }
  headerRow1.push({
    text: `รวม ${years.length} ปี`,
    colSpan: 2,
    style: 'tableHeader',
    alignment: 'center',
    bold: true,
  });
  headerRow1.push({ text: '', style: 'tableHeader' });
  summaryTableBody.push(headerRow1);

  const headerRow2: any[] = [{ text: '', style: 'tableHeader' }];
  for (const _ of years) {
    headerRow2.push({ text: newWord('จำนวน\n โครงการ'), style: 'tableHeader', alignment: 'center', bold: true });
    headerRow2.push({ text: newWord('งบประมาณ\n (บาท)'), style: 'tableHeader', alignment: 'center', bold: true });
  }
  headerRow2.push({ text: newWord('จำนวน\n โครงการ'), style: 'tableHeader', alignment: 'center', bold: true });
  headerRow2.push({ text: newWord('งบรวม  \n (บาท)'), style: 'tableHeader', alignment: 'center', bold: true });
  summaryTableBody.push(headerRow2);

  const sortedIssues: IssueSummary[] = Array.from(issues.values()).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );

  for (const issueSummary of sortedIssues) {
    const row: any[] = [];
    row.push({
      text: newWord(issueSummary.issueName || '-'),
      alignment: 'left',
    });

    let issueTotalCount = 0;
    let issueTotalSum = 0;
    for (const year of years) {
      const count = issueSummary.perYearCount[year] || 0;
      const sum = issueSummary.perYearSum[year] || 0;
      issueTotalCount += count;
      issueTotalSum += sum;
      row.push({ text: count ? String(count) : '', alignment: 'center' });
      row.push({ text: sum ? sum.toLocaleString('th-TH') : '', alignment: 'right' });
    }
    row.push({ text: issueTotalCount ? String(issueTotalCount) : '', alignment: 'center' });
    row.push({ text: issueTotalSum ? issueTotalSum.toLocaleString('th-TH') : '', alignment: 'right' });
    summaryTableBody.push(row);
  }

  const overallRow: any[] = [{ text: 'รวมทั้งสิ้น', alignment: 'right', bold: true }];
  for (const year of years) {
    overallRow.push({ text: overallCount[year] ? String(overallCount[year]) : '', alignment: 'center', bold: true });
    overallRow.push({ text: overallSum[year] ? overallSum[year].toLocaleString('th-TH') : '', alignment: 'right', bold: true });
  }
  const overallTotalCount = years.reduce((sum, year) => sum + (overallCount[year] || 0), 0);
  const summaryOverallTotalSum = years.reduce((sum, year) => sum + (overallSum[year] || 0), 0);
  overallRow.push({ text: overallTotalCount ? String(overallTotalCount) : '', alignment: 'center', bold: true });
  overallRow.push({ text: summaryOverallTotalSum ? summaryOverallTotalSum.toLocaleString('th-TH') : '', alignment: 'right', bold: true });
  summaryTableBody.push(overallRow);

  content.push({
    table: {
      headerRows: 2,
      widths: ['*', 30, 61, 30, 61, 30, 61, 30, 61, 30, 61, 30, 61],
      body: summaryTableBody,
    },
    layout: {
      hLineWidth: (i: number) => (i < 2 ? 1.2 : 0.8),
      vLineWidth: () => 0.8,
      hLineColor: () => '#000',
      vLineColor: () => '#000',
    },
  });

  return {
    header: function (currentPage: number) {
      if (currentPage === 1) return null;
      return {
        text: 'แบบ ผ.01',
        alignment: 'right',
        fontSize: 12,
        margin: [0, 40, 20, 0],
      };
    },
    footer: (currentPage) => {
      const footerText = newWord
        ? newWord(developmentPlanSupplementName)
        : developmentPlanSupplementName;
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
            text: String(currentPage),
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
    pageMargins,
    defaultStyle: { font: 'THSarabun', fontSize: 12 },
    styles: {
      tableHeader: { alignment: 'center', bold: true, fontSize: 12 },
    },
  };
};

/**
 * Format-aware entry point. Dispatches on `reportFormat`.
 */
export const createSupplementSummaryDocDefinition = (
  params: SupplementSummaryDocParams,
): TDocumentDefinitions => {
  if (params.reportFormat === 'ISSUE_BASED') {
    return renderIssueBasedSummary(params);
  }
  return renderStrategyBasedSummary(params);
};
