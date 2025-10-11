import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { PdfDraftDocument } from './entities/pdf-draft-document.entity';
import { PdfApprovedDocument } from './entities/pdf-approved-document.entity';
import { PdfInAuthorityDocument } from './entities/pdf-in-authority-document.entity';
import { PdfOutAuthorityDocument } from './entities/pdf-out-authority-document.entity';
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
    @InjectRepository(PdfApprovedDocument)
    private readonly pdfApprovedRepo: Repository<PdfApprovedDocument>,
    @InjectRepository(PdfInAuthorityDocument)
    private readonly pdfInAuthorityRepo: Repository<PdfInAuthorityDocument>,
    @InjectRepository(PdfOutAuthorityDocument)
    private readonly pdfOutAuthorityRepo: Repository<PdfOutAuthorityDocument>,
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
    return this.generateProjectReportWithColumns(projects, [
      'index', 'title', 'objective', 'target', 'budget', 'kpi', 'expectedResult', 'mainAgency'
    ]);
  }

  async generateProjectReportWithColumns(projects: any[], selectedColumns: string[]): Promise<Buffer> {
    const bp = await this.budgetPlanRepo.findOneBy({ isLatest: true });
    if (!bp) throw new Error('BudgetPlan not found');
    const budgetPlanName = bp?.name ?? 'ไม่พบแผนงบประมาณ';

    // Column mapping
    const columnMap = {
      'index': { text: 'ที่', key: 'index' },
      'title': { text: 'โครงการ/กิจกรรม', key: 'title' },
      'objective': { text: 'วัตถุประสงค์', key: 'objective' },
      'target': { text: 'เป้าหมาย', key: 'target' },
      'budget': { text: 'งบประมาณ (บาท)', key: 'budget' },
      'kpi': { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      'expectedResult': { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      'mainAgency': { text: 'หน่วยงานหลัก', key: 'mainAgency' }
    };

    // Filter selected columns
    const availableColumns = selectedColumns.filter(col => columnMap[col]);
    const isFullReport = availableColumns.length === Object.keys(columnMap).length;

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

      // Calculate total columns for colspan
      const totalColumns = availableColumns.length + (availableColumns.includes('budget') ? years.length - 1 : 0);
      
      // title row
      tableBody.push([
        {
          colSpan: totalColumns,
          stack: [
            { text: `ยุทธศาสตร์: ${strat}`, fontSize: 13 },
            { text: `กลยุทธ์: ${tac}`, fontSize: 13, margin: [20, 0, 0, 0] },
            { text: `แผนงาน: ${pl}`, fontSize: 13, margin: [40, 0, 0, 0] },
          ],
          border: [false, false, false, false],
        },
        ...Array(totalColumns - 1).fill({ text: '', border: [false, false, false, false] }),
      ]);

      // Generate header rows based on selected columns
      const headerRow1: any[] = [];
      const headerRow2: any[] = [];

      availableColumns.forEach(col => {
        if (col === 'budget') {
          headerRow1.push({ text: columnMap[col].text, colSpan: years.length, style: 'tableHeader' });
          headerRow1.push(...Array(years.length - 1).fill(''));
          headerRow2.push(...years.map((y) => ({ text: y.toString(), style: 'tableHeader' })));
        } else {
          headerRow1.push({ text: columnMap[col].text, rowSpan: 2, style: 'tableHeader' });
          headerRow2.push('');
        }
      });

      tableBody.push(headerRow1);
      tableBody.push(headerRow2);

      // data rows
      let idx = 1;
      for (const p of groupProjects) {
        const rowData: any[] = [];

        availableColumns.forEach(col => {
          switch (col) {
            case 'index':
              rowData.push({ text: String(idx++), alignment: 'center' });
              break;
            case 'title':
              rowData.push({
                text: this.newWord(p.title),
                font: 'THSarabun',
                alignment: 'justify',
              });
              break;
            case 'objective':
              rowData.push({
                text: this.newWord(p.objective),
                font: 'THSarabun',
                alignment: 'justify',
              });
              break;
            case 'target':
              rowData.push({
                text: this.newWord(p.goal),
                font: 'THSarabun',
                alignment: 'justify',
              });
              break;
            case 'budget':
              const budgetCells = years.map((y) => {
                const m = p.budgets?.find((b: any) => b.year === y);
                const v = m ? parseFloat(m.quantity) : NaN;
                return {
                  text: isNaN(v) ? '' : v.toLocaleString('th-TH'),
                  alignment: 'right',
                };
              });
              rowData.push(...budgetCells);
              break;
            case 'kpi':
              rowData.push({
                text: this.newWord(p.indicator),
                font: 'THSarabun',
                alignment: 'justify',
              });
              break;
            case 'expectedResult':
              rowData.push({
                text: this.newWord(p.expected),
                font: 'THSarabun',
                alignment: 'justify',
              });
              break;
            case 'mainAgency':
              const orgName = p.workHistory?.localAdministrativeOrganization?.name || '-';
              rowData.push({
                text: this.newWord(orgName),
                font: 'THSarabun',
              });
              break;
          }
        });

        tableBody.push(rowData);
      }
      // Generate summary row based on selected columns
      const summaryRow: any[] = [];
      let budgetColSpan = 0;
      let nonBudgetColSpan = 0;

      availableColumns.forEach(col => {
        if (col === 'budget') {
          budgetColSpan += years.length;
        } else {
          nonBudgetColSpan++;
        }
      });

      // Add summary row
      if (availableColumns.includes('budget')) {
        summaryRow.push({ text: 'รวมงบประมาณ', colSpan: nonBudgetColSpan, alignment: 'center', bold: true });
        summaryRow.push(...Array(nonBudgetColSpan - 1).fill({}));
        summaryRow.push(...years.map((y) => ({
          text: sumByYear[y] ? sumByYear[y].toLocaleString('th-TH') : '',
          alignment: 'center',
          bold: true,
        })));
      } else {
        summaryRow.push({ text: 'รวม', colSpan: totalColumns, alignment: 'center', bold: true });
        summaryRow.push(...Array(totalColumns - 1).fill({}));
      }

      tableBody.push(summaryRow);
      // Generate project count summary row
      const countSummaryRow: any[] = [];
      if (availableColumns.includes('budget')) {
        countSummaryRow.push({ text: 'รวมจำนวนโครงการ', colSpan: nonBudgetColSpan, alignment: 'center', bold: true });
        countSummaryRow.push(...Array(nonBudgetColSpan - 1).fill({}));
        countSummaryRow.push(...years.map((y) => ({
          text: countByYear[y] ? String(countByYear[y]) : '',
          alignment: 'center',
          bold: true,
        })));
      } else {
        countSummaryRow.push({ text: `รวมจำนวนโครงการ: ${groupProjects.length}`, colSpan: totalColumns, alignment: 'center', bold: true });
        countSummaryRow.push(...Array(totalColumns - 1).fill({}));
      }

      tableBody.push(countSummaryRow);

      // Calculate dynamic column widths based on selected columns
      const calculateColumnWidths = (selectedCols: string[]): string[] => {
        const widths: string[] = [];
        const baseWidths: Record<string, number> = {
          'index': 5,      // เลขที่ - แคบ
          'title': 25,     // ชื่อโครงการ - กว้างที่สุด
          'objective': 20, // วัตถุประสงค์ - กว้าง
          'target': 15,    // เป้าหมาย - กลาง
          'kpi': 12,       // ตัวชี้วัด - กลาง
          'expectedResult': 15, // ผลที่คาดหวัง - กลาง
          'mainAgency': 12,     // หน่วยงานหลัก - กลาง
        };
        
        // คำนวณพื้นที่ที่เหลือสำหรับงบประมาณ
        const nonBudgetColumns = selectedCols.filter(col => col !== 'budget');
        const usedWidth = nonBudgetColumns.reduce((sum, col) => sum + (baseWidths[col] || 10), 0);
        const budgetWidth = Math.max(20, 100 - usedWidth); // งบประมาณใช้พื้นที่ที่เหลืออย่างน้อย 20%
        
        selectedCols.forEach(col => {
          if (col === 'budget') {
            // งบประมาณแบ่งตามปี
            const budgetWidthPerYear = Math.max(6, Math.floor(budgetWidth / years.length));
            years.forEach(() => widths.push(`${budgetWidthPerYear}%`));
          } else {
            // ปรับความกว้างตามจำนวนคอลัมน์ที่เหลือ
            const baseWidth = baseWidths[col] || 10;
            const adjustedWidth = nonBudgetColumns.length <= 3 ? baseWidth * 1.5 : baseWidth;
            widths.push(`${adjustedWidth}%`);
          }
        });
        
        // ปรับให้รวม 100% อย่างแม่นยำ
        const totalWidth = widths.reduce((sum, w) => sum + parseFloat(w), 0);
        if (Math.abs(totalWidth - 100) > 0.1) {
          const adjustment = (100 - totalWidth) / widths.length;
          return widths.map(w => `${(parseFloat(w) + adjustment).toFixed(2)}%`);
        }
        
        return widths;
      };

      const columnWidths = calculateColumnWidths(availableColumns);

      // push table
      content.push({
        table: {
          headerRows: 3,
          widths: columnWidths,
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
      pageMargins: [15, 20, 15, 40], // ลด margin เพื่อใช้พื้นที่เต็มหน้ากระดาษ
      defaultStyle: { font: 'THSarabun', fontSize: 11 }, // ลดขนาดฟอนต์เล็กน้อย
      styles: {
        tableHeader: { alignment: 'center', bold: true, fontSize: 11 },
      },
      header: {
        text: 'แบบ ผ.02',
        alignment: 'right',
        margin: [0, 5, 5, 0],
        fontSize: 9,
      },
      footer: (currentPage: number) => ({
        text: String(currentPage),
        alignment: 'right',
        margin: [0, 0, 5, 0],
        fontSize: 9,
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

  // Approved PDF methods (สำหรับโครงการที่อนุมัติแล้ว)
  private async getNextApprovedVersion(budgetPlanId: string | number): Promise<number> {
    const latest = await this.pdfApprovedRepo.findOne({
      where: { budgetPlanId: String(budgetPlanId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  async saveApprovedPdfAndMeta(options: {
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

    const version = await this.getNextApprovedVersion(budgetPlanId);
    const fileName = `approved-plan-v${version}.pdf`;
    const absFilePath = path.join(baseDir, fileName);

    // write pdf file
    await fsp.writeFile(absFilePath, options.pdfBuffer);

    // save to database
    const pdfApproved = this.pdfApprovedRepo.create({
      budgetPlanId: String(budgetPlanId),
      version,
      filePath: absFilePath,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfApprovedRepo.save(pdfApproved);
    
    // get user info
    const user = await this.userRepo.findOne({
      where: { id: options.createdById },
      select: ['id', 'firstname', 'lastname']
    });

    const fileUrl = `/v1/pdf/approved/latest/stream`;
    return {
      version: saved.version,
      filePath: saved.filePath,
      fileUrl,
      projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestApprovedMeta(): Promise<
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
    const latest = await this.pdfApprovedRepo.findOne({
      where: { budgetPlanId: String(bp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };

    return {
      exists: true,
      version: latest.version,
      fileUrl: `/v1/pdf/approved/latest/stream`,
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

  async getAllApprovedVersions(): Promise<Array<{
    version: number;
    fileUrl: string;
    projectCount: number;
    createdAt: string;
    createdBy: { id: string; firstname: string; lastname: string };
  }>> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const versions = await this.pdfApprovedRepo.find({
      where: { budgetPlanId: String(bp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version,
      fileUrl: `/v1/pdf/approved/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: {
        id: v.createdBy.id,
        firstname: v.createdBy.firstname,
        lastname: v.createdBy.lastname
      }
    }));
  }

  async readApprovedFileByVersion(version: number): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const approved = await this.pdfApprovedRepo.findOne({
      where: { budgetPlanId: String(bp.id), version },
      relations: ['createdBy']
    });

    if (!approved) return null;
    
    const stream = fs.createReadStream(approved.filePath);
    return { filePath: approved.filePath, stream };
  }

  async readLatestApprovedFile(): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestApprovedMeta();
    if (!meta || !meta.exists) return null;
    const stream = fs.createReadStream(meta.filePath);
    return { filePath: meta.filePath, stream };
  }

  // In Authority PDF methods (สำหรับโครงการที่อยู่ในอำนาจ)
  private async getNextInAuthorityVersion(budgetPlanId: string | number): Promise<number> {
    const latest = await this.pdfInAuthorityRepo.findOne({
      where: { budgetPlanId: String(budgetPlanId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  async saveInAuthorityPdfAndMeta(options: {
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

    const version = await this.getNextInAuthorityVersion(budgetPlanId);
    const fileName = `in-authority-plan-v${version}.pdf`;
    const absFilePath = path.join(baseDir, fileName);

    // write pdf file
    await fsp.writeFile(absFilePath, options.pdfBuffer);

    // save to database
    const pdfInAuthority = this.pdfInAuthorityRepo.create({
      budgetPlanId: String(budgetPlanId),
      version,
      filePath: absFilePath,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfInAuthorityRepo.save(pdfInAuthority);
    
    // get user info
    const user = await this.userRepo.findOne({
      where: { id: options.createdById },
      select: ['id', 'firstname', 'lastname']
    });

    const fileUrl = `/v1/pdf/in-authority/latest/stream`;
    return {
      version: saved.version,
      filePath: saved.filePath,
      fileUrl,
      projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestInAuthorityMeta(): Promise<
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
    const latest = await this.pdfInAuthorityRepo.findOne({
      where: { budgetPlanId: String(bp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };

    return {
      exists: true,
      version: latest.version,
      fileUrl: `/v1/pdf/in-authority/latest/stream`,
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

  async getAllInAuthorityVersions(): Promise<Array<{
    version: number;
    fileUrl: string;
    projectCount: number;
    createdAt: string;
    createdBy: { id: string; firstname: string; lastname: string };
  }>> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const versions = await this.pdfInAuthorityRepo.find({
      where: { budgetPlanId: String(bp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version,
      fileUrl: `/v1/pdf/in-authority/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: {
        id: v.createdBy.id,
        firstname: v.createdBy.firstname,
        lastname: v.createdBy.lastname
      }
    }));
  }

  async readInAuthorityFileByVersion(version: number): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const inAuthority = await this.pdfInAuthorityRepo.findOne({
      where: { budgetPlanId: String(bp.id), version },
      relations: ['createdBy']
    });

    if (!inAuthority) return null;
    
    const stream = fs.createReadStream(inAuthority.filePath);
    return { filePath: inAuthority.filePath, stream };
  }

  async readLatestInAuthorityFile(): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestInAuthorityMeta();
    if (!meta || !meta.exists) return null;
    const stream = fs.createReadStream(meta.filePath);
    return { filePath: meta.filePath, stream };
  }

  // Out Authority PDF methods (สำหรับโครงการนอกอำนาจ)
  private async getNextOutAuthorityVersion(budgetPlanId: string | number): Promise<number> {
    const latest = await this.pdfOutAuthorityRepo.findOne({
      where: { budgetPlanId: String(budgetPlanId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  async saveOutAuthorityPdfAndMeta(options: {
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

    const version = await this.getNextOutAuthorityVersion(budgetPlanId);
    const fileName = `out-authority-plan-v${version}.pdf`;
    const absFilePath = path.join(baseDir, fileName);

    // write pdf file
    await fsp.writeFile(absFilePath, options.pdfBuffer);

    // save to database
    const pdfOutAuthority = this.pdfOutAuthorityRepo.create({
      budgetPlanId: String(budgetPlanId),
      version,
      filePath: absFilePath,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfOutAuthorityRepo.save(pdfOutAuthority);
    
    // get user info
    const user = await this.userRepo.findOne({
      where: { id: options.createdById },
      select: ['id', 'firstname', 'lastname']
    });

    const fileUrl = `/v1/pdf/out-authority/latest/stream`;
    return {
      version: saved.version,
      filePath: saved.filePath,
      fileUrl,
      projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestOutAuthorityMeta(): Promise<
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
    const latest = await this.pdfOutAuthorityRepo.findOne({
      where: { budgetPlanId: String(bp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };

    return {
      exists: true,
      version: latest.version,
      fileUrl: `/v1/pdf/out-authority/latest/stream`,
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

  async getAllOutAuthorityVersions(): Promise<Array<{
    version: number;
    fileUrl: string;
    projectCount: number;
    createdAt: string;
    createdBy: { id: string; firstname: string; lastname: string };
  }>> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const versions = await this.pdfOutAuthorityRepo.find({
      where: { budgetPlanId: String(bp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version,
      fileUrl: `/v1/pdf/out-authority/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: {
        id: v.createdBy.id,
        firstname: v.createdBy.firstname,
        lastname: v.createdBy.lastname
      }
    }));
  }

  async readOutAuthorityFileByVersion(version: number): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const bp = await this.getLatestBudgetPlanOrFail();
    const outAuthority = await this.pdfOutAuthorityRepo.findOne({
      where: { budgetPlanId: String(bp.id), version },
      relations: ['createdBy']
    });

    if (!outAuthority) return null;
    
    const stream = fs.createReadStream(outAuthority.filePath);
    return { filePath: outAuthority.filePath, stream };
  }

  async readLatestOutAuthorityFile(): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestOutAuthorityMeta();
    if (!meta || !meta.exists) return null;
    const stream = fs.createReadStream(meta.filePath);
    return { filePath: meta.filePath, stream };
  }
}
