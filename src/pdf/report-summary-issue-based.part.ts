import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { IssueBasedCoverSummaryDocParams } from './report.types';

export const createIssueBasedSummaryPartDocDefinition = (
  params: IssueBasedCoverSummaryDocParams,
): TDocumentDefinitions => {
  const {
    developmentPlanName,
    years,
    issues,
    overallSum,
    overallCount,
    pageMargins,
    pageOrientation,
    newWord,
    // §21.3 (2026-05-31 hotfix) — pageOffset baked into the footer so
    // the summary's footer page numbers continue the running count of
    // an enclosing assembled book (e.g. Part 3 inside MAIN_PLAN merge
    // receives `pageCount(P1)+pageCount(P2)` here). Defaults to 0 for
    // standalone callers — preserves pre-hotfix behavior.
    pageOffset = 0,
  } = params;

  const content: any[] = [];

  // Cover page title
  content.push({
    text: (params as any).coverTitle ?? 'รายละเอียดโครงการ',
    fontSize: 48,
    bold: true,
    alignment: 'center',
    margin: [0, 200, 0, 0],
  });

  // Summary table header text (starts on new page)
  content.push({
    stack: [
      'บัญชีสรุปโครงการพัฒนา \n',
      developmentPlanName + '\n',
      'องค์การบริหารส่วนจังหวัดนครราชสีมา\n',
    ],
    alignment: 'center',
    bold: true,
    margin: [0, 10, 0, 0],
    fontSize: 12,
    pageBreak: 'before',
  });

  // Build summary table
  const summaryTableBody: any[] = [];
  const summaryDataColumns = years.length * 2 + 2;
  const totalSummaryColumns = 1 + summaryDataColumns;

  // Header row 1: "ประเด็นการพัฒนา" + year columns + total column
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

  // Header row 2: sub-headers (count / budget)
  const headerRow2: any[] = [{ text: '', style: 'tableHeader' }];
  for (const _ of years) {
    headerRow2.push({
      text: newWord('จำนวน\n โครงการ'),
      style: 'tableHeader',
      alignment: 'center',
      bold: true,
    });
    headerRow2.push({
      text: newWord('งบประมาณ\n (บาท)'),
      style: 'tableHeader',
      alignment: 'center',
      bold: true,
    });
  }
  headerRow2.push({
    text: newWord('จำนวน\n โครงการ'),
    style: 'tableHeader',
    alignment: 'center',
    bold: true,
  });
  headerRow2.push({
    text: newWord('งบรวม  \n (บาท)'),
    style: 'tableHeader',
    alignment: 'center',
    bold: true,
  });
  summaryTableBody.push(headerRow2);

  // Sort issues by sortOrder then render one flat row per issue
  const sortedIssues = Array.from(issues.values()).sort(
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
      row.push({
        text: count ? String(count) : '',
        alignment: 'center',
      });
      row.push({
        text: sum ? sum.toLocaleString('th-TH') : '',
        alignment: 'right',
      });
    }
    row.push({
      text: issueTotalCount ? String(issueTotalCount) : '',
      alignment: 'center',
    });
    row.push({
      text: issueTotalSum ? issueTotalSum.toLocaleString('th-TH') : '',
      alignment: 'right',
    });

    summaryTableBody.push(row);
  }

  // Overall totals row
  const overallRow: any[] = [
    { text: 'รวมทั้งสิ้น', alignment: 'right', bold: true },
  ];
  for (const year of years) {
    overallRow.push({
      text: overallCount[year] ? String(overallCount[year]) : '',
      alignment: 'center',
      bold: true,
    });
    overallRow.push({
      text: overallSum[year]
        ? overallSum[year].toLocaleString('th-TH')
        : '',
      alignment: 'right',
      bold: true,
    });
  }
  const overallTotalCount = years.reduce(
    (sum, year) => sum + (overallCount[year] || 0),
    0,
  );
  const overallTotalSum = years.reduce(
    (sum, year) => sum + (overallSum[year] || 0),
    0,
  );
  overallRow.push({
    text: overallTotalCount ? String(overallTotalCount) : '',
    alignment: 'center',
    bold: true,
  });
  overallRow.push({
    text: overallTotalSum ? overallTotalSum.toLocaleString('th-TH') : '',
    alignment: 'right',
    bold: true,
  });
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
      // Skip header on cover page (first page)
      if (currentPage === 1) return null;
      return {
        text: 'แบบ ผ.01',
        alignment: 'right',
        fontSize: 12,
        margin: [0, 40, 20, 0],
      };
    },
    footer: (currentPage, _pageCount) => {
      const footerText = newWord
        ? newWord(developmentPlanName)
        : developmentPlanName;
      // §21.3 (2026-05-31 hotfix) — see report-summary.part.ts for the
      // parallel STRATEGY_BASED fix. currentPage is pdfmake's local
      // 1-based page within this summary doc; add pageOffset to match
      // the absolute book page when this doc sits inside an assembled
      // book (e.g. Part 3 of MAIN_PLAN).
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
    pageMargins,
    defaultStyle: { font: 'THSarabun', fontSize: 12 },
    styles: {
      tableHeader: { alignment: 'center', bold: true, fontSize: 12 },
    },
  };
};
