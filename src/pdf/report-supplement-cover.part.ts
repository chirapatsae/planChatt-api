/**
 * SUPP_PRINT_BE_02 — Supplement cover page.
 *
 * Q3 LOCKED title (byte-for-byte, UX_01 confirmed):
 *   "เล่มเพิ่มเติมรอบที่ {supplementNumber} พ.ศ. {startYearBE}-{endYearBE}"
 *
 * Subtitle: parent DevelopmentPlan name (+ optional description block).
 * Footer:   parent plan name + page number (continuation of the assembled
 *           document; the actual page count comes from pdfmake at render).
 *
 * Format badge (§16.9, admin-side cover page):
 *   STRATEGY_BASED → "แบบยุทธศาสตร์"
 *   ISSUE_BASED    → "แบบประเด็นการพัฒนา"
 *
 * The cover page does NOT add 543 to the year fields — DevelopmentPlan.startYear /
 * endYear are already stored in Buddhist Era per existing main-plan conventions
 * (e.g. saveApprovedPdfAndMetaForPlan filename pattern uses them verbatim).
 *
 * PII (§17): only the WorkHistory display name is exposed; no email / id.
 */

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { SupplementCoverDocParams } from './report.types';

const FORMAT_BADGE_TEXT: Record<'STRATEGY_BASED' | 'ISSUE_BASED', string> = {
  STRATEGY_BASED: 'แบบยุทธศาสตร์',
  ISSUE_BASED: 'แบบประเด็นการพัฒนา',
};

const TH_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

/**
 * Format a Date into "วันที่ D MMMM พ.ศ. YYYY เวลา HH:mm น." (Thai-BE).
 * Wall-clock Bangkok representation is intentionally derived from local
 * server time to match existing footer conventions.
 */
const formatThaiBuddhistDateTime = (d: Date): string => {
  const day = d.getDate();
  const month = TH_MONTHS[d.getMonth()] ?? '';
  const yearBE = d.getFullYear() + 543;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `วันที่ ${day} ${month} พ.ศ. ${yearBE} เวลา ${hh}:${mm} น.`;
};

/**
 * Build the supplement cover page document definition.
 *
 * The returned definition renders exactly one page (the cover). Callers
 * concatenate this buffer in front of the summary + detail buffers to form
 * the final PDF.
 */
export const createSupplementCoverPageDocDefinition = (
  params: SupplementCoverDocParams,
): TDocumentDefinitions => {
  const {
    supplementNumber,
    startYearBE,
    endYearBE,
    parentPlanName,
    supplementDescription,
    generatedAt,
    generatedByName,
    reportFormat,
    pageMargins,
    pageOrientation,
    newWord,
  } = params;

  // Q3 LOCKED label — DO NOT alter spacing / punctuation / order.
  const coverTitle = `เล่มเพิ่มเติมรอบที่ ${supplementNumber} พ.ศ. ${startYearBE}-${endYearBE}`;

  const badgeText = FORMAT_BADGE_TEXT[reportFormat];
  const generatedAtText = formatThaiBuddhistDateTime(generatedAt);

  const pageSize =
    pageOrientation === 'landscape'
      ? { width: 842, height: 595 }
      : { width: 595, height: 842 };
  const availablePageHeight = pageSize.height - pageMargins[1] - pageMargins[3];

  const content: any[] = [];

  // Top spacer pushes the title roughly into upper-third of the page,
  // leaving room for subtitle / description / generation metadata below.
  const titleTopMargin = Math.max(0, Math.floor(availablePageHeight * 0.18));

  content.push({
    text: coverTitle,
    fontSize: 36,
    bold: true,
    alignment: 'center',
    margin: [0, titleTopMargin, 0, 12],
  });

  // Format badge (§16.9 admin-cover).
  content.push({
    text: badgeText,
    fontSize: 18,
    bold: true,
    alignment: 'center',
    color: '#444',
    margin: [0, 0, 0, 24],
  });

  // Parent plan subtitle.
  content.push({
    text: newWord(parentPlanName || '-'),
    fontSize: 18,
    bold: true,
    alignment: 'center',
    margin: [0, 0, 0, 6],
  });

  content.push({
    text: 'องค์การบริหารส่วนจังหวัดนครราชสีมา',
    fontSize: 16,
    bold: true,
    alignment: 'center',
    margin: [0, 0, 0, 30],
  });

  // Optional supplement description block.
  if (supplementDescription && supplementDescription.trim().length > 0) {
    content.push({
      text: newWord(supplementDescription),
      fontSize: 14,
      alignment: 'center',
      italics: true,
      color: '#333',
      margin: [40, 0, 40, 24],
    });
  }

  // Generation metadata (Thai-BE timestamp + generator name).
  content.push({
    stack: [
      { text: generatedAtText, alignment: 'center', fontSize: 12 },
      {
        text: `จัดทำโดย: ${generatedByName || '-'}`,
        alignment: 'center',
        fontSize: 12,
        margin: [0, 4, 0, 0],
      },
    ],
    margin: [0, 20, 0, 0],
  });

  return {
    header: function () {
      // Cover page has no top header.
      return null;
    },
    footer: function (currentPage: number, pageCount: number) {
      // Footer carries parent plan name + page x of y placeholder.
      const footerText = newWord(parentPlanName || '');
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
            text: `หน้า ${currentPage} / ${pageCount}`,
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
    pageMargins: [40, 60, 40, 40],
    defaultStyle: { font: 'THSarabun', fontSize: 12 },
  };
};
