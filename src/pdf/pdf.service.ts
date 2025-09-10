import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { PdfDraftDocument } from './entities/pdf-draft-document.entity';
import { User } from 'src/users/entities/user.entity';
import * as PdfPrinter from 'pdfmake';
import * as path from 'path';
import * as Wordcut from 'wordcut';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

@Injectable()
export class PdfService {
  constructor(
    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepo: Repository<BudgetPlan>,
    @InjectRepository(PdfDraftDocument)
    private readonly pdfDraftRepo: Repository<PdfDraftDocument>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    Wordcut.init();
  }

  private newWord(text: string) {
    const parts = Wordcut.cut(text || '')
      .split('|')
      .map((data: any) => {
        return {
          text: [data, { text: '\u200b', font: 'Roboto' }],
        };
      });
    return parts;
  }

  async generateProjectReport(projects: any[]): Promise<Buffer> {
    const bp = await this.budgetPlanRepo.findOneBy({ isLatest: true });
    if (!bp) throw new Error('BudgetPlan not found');
    const budgetPlanName = bp?.name ?? 'ไม่พบแผนงบประมาณ';

    const fonts = {
      THSarabun: {
        normal: path.resolve(__dirname, '../fonts/THSarabun.ttf'),
        bold: path.resolve(__dirname, '../fonts/THSarabun-Bold.ttf'),
        italics: path.resolve(__dirname, '../fonts/THSarabun-Italic.ttf'),
        bolditalics: path.resolve(
          __dirname,
          '../fonts/THSarabun-BoldItalic.ttf',
        ),
      },
      Roboto: {
        normal: path.resolve(__dirname, '../fonts/Roboto-Regular.ttf'),
        bold: path.resolve(__dirname, '../fonts/Roboto-Medium.ttf'),
        italics: path.resolve(__dirname, '../fonts/Roboto-Italic.ttf'),
        bolditalics: path.resolve(
          __dirname,
          '../fonts/Roboto-MediumItalic.ttf',
        ),
      },
    };
    const printer = new PdfPrinter(fonts);

    const grouped = new Map<string, any[]>();
    for (const p of projects) {
      const key = `${p.strategy?.name}||${p.tactic?.name}||${p.plan?.name}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(p);
    }

    const content: any[] = [];
    // Dynamically generate years array from bp.startYear to bp.endYear
    const years = Array.from(
      { length: bp.endYear - bp.startYear + 1 },
      (_, i) => bp.startYear + i,
    );

    for (const [groupKey, groupProjects] of grouped.entries()) {
      const [strat, tac, pl] = groupKey.split('||');

      // Dynamically create sumByYear and countByYear objects
      const sumByYear: Record<number, number> = Object.fromEntries(
        years.map((y) => [y, 0]),
      );
      const countByYear: Record<number, number> = Object.fromEntries(
        years.map((y) => [y, 0]),
      );
      for (const p of groupProjects) {
        for (const b of p.budgets || []) {
          const y = b.year,
            q = parseFloat(b.quantity);
          if (!isNaN(q) && sumByYear[y] !== undefined) {
            sumByYear[y] += q;
            countByYear[y]++;
          }
        }
      }

      content.push({
        text: [
          '\n',
          { text: 'รายละเอียดโครงการ\n', bold: true, fontSize: 14 },
          budgetPlanName + '\n',
          'องค์การบริหารส่วนจังหวัดนครราชสีมา\n',
        ],
        alignment: 'center',
        margin: [0, 10, 0, 10],
        fontSize: 14,
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
        '',
        '',
        '',
        '',
        ...years.map((y) => ({ text: y.toString(), style: 'tableHeader' })),
        '',
        '',
        '',
      ]);

      // data rows
      let idx = 1;
      for (const p of groupProjects) {
        // budget cells (no justify)
        const budgetCells = years.map((y) => {
          const m = p.budgets?.find((b: any) => b.year === y);
          const v = m ? parseFloat(m.quantity) : NaN;
          return {
            text: isNaN(v) ? '' : v.toLocaleString('th-TH'),
            alignment: 'right',
          };
        });

        const orgName =
          p.workHistory?.localAdministrativeOrganization?.name || '-';

        tableBody.push([
          { text: String(idx++), alignment: 'center' },
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
          {
            text: this.newWord(orgName),
            font: 'THSarabun',
          },
        ]);
      }
      tableBody.push([
        { text: 'รวมงบประมาณ', colSpan: 4, alignment: 'center', bold: true },
        {},
        {},
        {},
        ...years.map((y) => ({
          text: sumByYear[y] ? sumByYear[y].toLocaleString('th-TH') : '',
          alignment: 'center',
          bold: true,
        })),
        { text: '', colSpan: 3 },
        {},
        {},
      ]);
      tableBody.push([
        {
          text: 'รวมจำนวนโครงการ',
          colSpan: 4,
          alignment: 'center',
          bold: true,
        },
        {},
        {},
        {},
        ...years.map((y) => ({
          text: countByYear[y] ? String(countByYear[y]) : '',
          alignment: 'center',
          bold: true,
        })),
        { text: '', colSpan: 3 },
        {},
        {},
      ]);

      // push table
      content.push({
        table: {
          headerRows: 3,
          widths: [
            '3%',
            '9%',
            '12%',
            '14%',
            ...years.map(() => '7%'),
            '10%',
            '10%',
            '8%',
          ],
          body: tableBody,
        },
        layout: {
          hLineWidth: (i, node) => (node.table.body[i]?.[0]?.stack ? 0 : 0.3),
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
      styles: {
        tableHeader: { alignment: 'center', bold: true, fontSize: 12 },
      },
      header: {
        text: 'แบบ ผ.02',
        alignment: 'right',
        margin: [0, 10, 10, 0],
        fontSize: 10,
      },
      footer: (currentPage: number) => ({
        text: String(currentPage),
        alignment: 'right',
        margin: [0, 0, 10, 0],
      }),
    };

    // generate buffer
    const pdfDoc = printer.createPdfKitDocument(docDefinition);
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      pdfDoc.on('data', (chunk) => chunks.push(chunk));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', (err) => reject(err));
      pdfDoc.end();
    });
  }

  // Database-backed draft PDF persistence
  private async ensureDirectory(directoryPath: string): Promise<void> {
    await fsp.mkdir(directoryPath, { recursive: true });
  }

  private async getLatestBudgetPlanOrFail(): Promise<BudgetPlan> {
    const bp = await this.budgetPlanRepo.findOneBy({ isLatest: true });
    if (!bp) throw new Error('BudgetPlan not found');
    return bp;
  }

  private getDraftBaseDir(): string {
    // uploads/pdf/{budgetPlanId}
    const root = path.resolve(__dirname, '../../uploads/pdf');
    return root;
  }

  private getBudgetPlanDir(budgetPlanId: string | number): string {
    return path.join(this.getDraftBaseDir(), String(budgetPlanId));
  }

  private async getNextVersion(budgetPlanId: string | number): Promise<number> {
    const latest = await this.pdfDraftRepo.findOne({
      where: { budgetPlanId: String(budgetPlanId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  async saveDraftPdfAndMeta(options: {
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
  }): Promise<{
    version: number;
    filePath: string;
    fileUrl: string;
    projectCount: number;
    createdAt: string;
    createdBy: { id: string; firstname: string; lastname: string };
  }> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const budgetPlanId = bp.id;
    const baseDir = this.getBudgetPlanDir(budgetPlanId);
    await this.ensureDirectory(baseDir);

    const version = await this.getNextVersion(budgetPlanId);
    const fileName = `draft-plan-v${version}.pdf`;
    const absFilePath = path.join(baseDir, fileName);

    // write pdf file
    await fsp.writeFile(absFilePath, options.pdfBuffer);

    // save to database
    const pdfDraft = this.pdfDraftRepo.create({
      budgetPlanId: String(budgetPlanId),
      version,
      filePath: absFilePath,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfDraftRepo.save(pdfDraft);
    
    // get user info
    const user = await this.userRepo.findOne({
      where: { id: options.createdById },
      select: ['id', 'firstname', 'lastname']
    });

    const fileUrl = `/v1/pdf/draft/latest/stream`;
    return {
      version: saved.version,
      filePath: saved.filePath,
      fileUrl,
      projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestDraftMeta(): Promise<
    | {
        exists: false;
      }
    | {
        exists: true;
        version: number;
        fileUrl: string;
        projectCount: number;
        createdAt: string;
        projectIdsSnapshot: Array<string | number>;
        filePath: string;
        createdBy: { id: string; firstname: string; lastname: string };
      }
  > {
    const bp = await this.getLatestBudgetPlanOrFail();
    const latest = await this.pdfDraftRepo.findOne({
      where: { budgetPlanId: String(bp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };

    return {
      exists: true,
      version: latest.version,
      fileUrl: `/v1/pdf/draft/latest/stream`,
      projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(),
      projectIdsSnapshot: latest.projectIdsSnapshot,
      filePath: latest.filePath,
      createdBy: {
        id: latest.createdBy.id,
        firstname: latest.createdBy.firstname,
        lastname: latest.createdBy.lastname
      }
    };
  }

  async readLatestDraftFile(): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestDraftMeta();
    if (!meta || !meta.exists) return null;
    const stream = fs.createReadStream(meta.filePath);
    return { filePath: meta.filePath, stream };
  }

  async getAllDraftVersions(): Promise<Array<{
    version: number;
    fileUrl: string;
    projectCount: number;
    createdAt: string;
    createdBy: { id: string; firstname: string; lastname: string };
  }>> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const versions = await this.pdfDraftRepo.find({
      where: { budgetPlanId: String(bp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version,
      fileUrl: `/v1/pdf/draft/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: {
        id: v.createdBy.id,
        firstname: v.createdBy.firstname,
        lastname: v.createdBy.lastname
      }
    }));
  }

  async readDraftFileByVersion(version: number): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const draft = await this.pdfDraftRepo.findOne({
      where: { budgetPlanId: String(bp.id), version },
      relations: ['createdBy']
    });

    if (!draft) return null;
    
    const stream = fs.createReadStream(draft.filePath);
    return { filePath: draft.filePath, stream };
  }
}
