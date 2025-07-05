import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import * as PdfPrinter from 'pdfmake';
import * as path from 'path';
import * as Wordcut from 'wordcut';

@Injectable()
export class PdfService {
  constructor(
    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepo: Repository<BudgetPlan>,
  ) {
    // Load the Thai wordcut dictionary once
    Wordcut.init();
  }

  /**
   * Breaks Thai text into wordcut segments for inline rendering.
   */
  private newWord(text: string) {
    const parts = Wordcut.cut(text || '').split('|').map((data: any) => {
      return {
        text: [
          data,
          { text: '\u200b', font: 'Roboto' }
        ],
      };
    });
    return parts;
  }

  async generateProjectReport(projects: any[]): Promise<Buffer> {
    // 1) load active budget plan
    const bp = await this.budgetPlanRepo.findOneBy({ isActive: true });
    const budgetPlanName = bp?.name ?? 'ไม่พบแผนงบประมาณ';

    // 2) font definitions
    const fonts = {
      THSarabun: {
        normal: path.resolve(__dirname, '../fonts/THSarabun.ttf'),
        bold: path.resolve(__dirname, '../fonts/THSarabun-Bold.ttf'),
        italics: path.resolve(__dirname, '../fonts/THSarabun-Italic.ttf'),
        bolditalics: path.resolve(__dirname, '../fonts/THSarabun-BoldItalic.ttf'),
      },
      Roboto: {
        normal: path.resolve(__dirname, '../fonts/Roboto-Regular.ttf'),
        bold: path.resolve(__dirname, '../fonts/Roboto-Medium.ttf'),
        italics: path.resolve(__dirname, '../fonts/Roboto-Italic.ttf'),
        bolditalics: path.resolve(__dirname, '../fonts/Roboto-MediumItalic.ttf'),
      }
    };
    const printer = new PdfPrinter(fonts);

    // 3) group by strategy||tactic||plan
    const grouped = new Map<string, any[]>();
    for (const p of projects) {
      const key = `${p.strategy?.name}||${p.tactic?.name}||${p.plan?.name}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(p);
    }

    const content: any[] = [];
    const years = [2568, 2569, 2570, 2571, 2572] as const;

    for (const [groupKey, groupProjects] of grouped.entries()) {
      const [strat, tac, pl] = groupKey.split('||');

      // compute sums & counts
      const sumByYear: Record<number, number> = { 2568: 0, 2569: 0, 2570: 0, 2571: 0, 2572: 0 };
      const countByYear: Record<number, number> = { 2568: 0, 2569: 0, 2570: 0, 2571: 0, 2572: 0 };
      for (const p of groupProjects) {
        for (const b of p.budgets || []) {
          const y = b.year, q = parseFloat(b.quantity);
          if (!isNaN(q) && sumByYear[y] !== undefined) {
            sumByYear[y] += q; countByYear[y]++;
          }
        }
      }

      // section header
      content.push({
        text: [
          '\n',
          { text: 'รายละเอียดโครงการ\n', bold: true, fontSize: 14 },
          budgetPlanName + '\n',
          'องค์การบริหารส่วนจังหวัดนครราชสีมา\n',
        ],
        alignment: 'center',
        margin: [0, 10, 0, 10],
        fontSize : 14,
        pageBreak: content.length ? 'before' : undefined,
      });

      // table body
      const tableBody: any[] = [];

      // title row
      tableBody.push([
        {
          colSpan: 12,
          stack: [
            { text: `ยุทธศาสตร์: ${strat}`, fontSize: 13 },
            { text: `กลยุทธ์: ${tac}`, fontSize: 13, margin: [20, 0, 0, 0] },
            { text: `แผนงาน: ${pl}`, fontSize: 13, margin: [40, 0, 0, 0] },
          ],
          border: [false, false, false, false],
        },
        ...Array(11).fill({ text: '', border: [false, false, false, false] }),
      ]);

      // header rows
      tableBody.push([
        { text: 'ที่', rowSpan: 2, style: 'tableHeader' },
        { text: 'โครงการ/กิจกรรม', rowSpan: 2, style: 'tableHeader' },
        { text: 'วัตถุประสงค์', rowSpan: 2, style: 'tableHeader' },
        { text: 'เป้าหมาย', rowSpan: 2, style: 'tableHeader' },
        { text: 'งบประมาณ (บาท)', colSpan: years.length, style: 'tableHeader' },
        ...Array(years.length - 1).fill(''),
        { text: 'ตัวชี้วัด (KPI)', rowSpan: 2, style: 'tableHeader' },
        { text: 'ผลที่คาดว่าจะได้รับ', rowSpan: 2, style: 'tableHeader' },
        { text: 'หน่วยงานหลัก', rowSpan: 2, style: 'tableHeader' },
      ]);
      tableBody.push([
        '', '', '', '',
        ...years.map(y => ({ text: y.toString(), style: 'tableHeader' })),
        '', '', '',
      ]);

      // data rows
      let idx = 1;
      for (const p of groupProjects) {
        // budget cells (no justify)
        const budgetCells = years.map(y => {
          const m = p.budgets?.find((b: any) => b.year === y);
          const v = m ? parseFloat(m.quantity) : NaN;
          return { text: isNaN(v) ? '' : v.toLocaleString('th-TH'), alignment: 'right' };
        });

        const orgName = p.workHistory?.localAdministrativeOrganization?.name || '-';

        tableBody.push([
          // index – keep centered
          { text: String(idx++), alignment: 'center' },

          // these text cells get justify alignment
          {
            text: this.newWord(p.title),
            font: 'THSarabun',
            alignment: 'justify',
          },
          {
            text: this.newWord(p.objective),
            font: 'THSarabun',
            alignment: 'justify',
          },
          {
            text: this.newWord(p.goal),
            font: 'THSarabun',
            alignment: 'justify',
          },

          // budget columns (no justify)
          ...budgetCells,

          {
            text: this.newWord(p.indicator),
            font: 'THSarabun',
            alignment: 'justify',
          },
          {
            text: this.newWord(p.expected),
            font: 'THSarabun',
            alignment: 'justify',
          },

          // organization – justify as well
          {
            text: this.newWord(orgName),
            font: 'THSarabun',
          },
        ]);
      }

      // totals
      tableBody.push([
        { text: 'รวมงบประมาณ', colSpan: 4, alignment: 'center', bold: true }, {}, {}, {},
        ...years.map(y => ({
          text: sumByYear[y] ? sumByYear[y].toLocaleString('th-TH') : '',
          alignment: 'center', bold: true,
        })),
        { text: '', colSpan: 3 }, {}, {}
      ]);
      tableBody.push([
        { text: 'รวมจำนวนโครงการ', colSpan: 4, alignment: 'center', bold: true }, {}, {}, {},
        ...years.map(y => ({
          text: countByYear[y] ? String(countByYear[y]) : '',
          alignment: 'center', bold: true,
        })),
        { text: '', colSpan: 3 }, {}, {}
      ]);

      // push table
      content.push({
        table: {
          headerRows: 3,
          widths: ['3%', '9%', '12%', '14%', ...years.map(() => '7%'), '10%', '10%', '8%'],
          body: tableBody,
        },
        layout: {
          hLineWidth: (i, node) => node.table.body[i]?.[0]?.stack ? 0 : 0.3,
          vLineWidth: () => 0.3,
          hLineColor: () => '#000',
          vLineColor: () => '#000',
        },
      });
    }

    // document definition
    const docDefinition = {
      content,
      pageSize: 'A4',
      pageOrientation: 'landscape',
      pageMargins: [28, 28, 28, 56],
      defaultStyle: { font: 'THSarabun', fontSize: 12 },
      styles: { tableHeader: { alignment: 'center', bold: true, fontSize: 12 } },
      header: { text: 'แบบ ผ.02', alignment: 'right', margin: [0, 10, 10, 0], fontSize: 10 },
      footer: (currentPage: number) => ({ text: String(currentPage), alignment: 'right', margin: [0, 0, 10, 0] }),
    };

    // generate buffer
    const pdfDoc = printer.createPdfKitDocument(docDefinition);
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      pdfDoc.on('data', chunk => chunks.push(chunk));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', err => reject(err));
      pdfDoc.end();
    });
  }
}
