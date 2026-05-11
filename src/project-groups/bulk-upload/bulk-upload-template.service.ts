import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { PlanTactic } from 'src/plan/entities/plan-tactic.entity';

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');

/**
 * Result envelope returned to the controller.
 */
export interface BulkUploadTemplateBuildResult {
  buffer: Buffer;
  filename: string;
  reportFormat: ReportFormat;
  developmentPlanId: string;
}

/**
 * Reference data loaded once per template build. Used to populate both
 * the example rows (1-2 sample rows under the header) and the full
 * "ข้อมูลอ้างอิง" lookup sheet. Either the issue branch OR the strategy
 * branch is populated, never both.
 */
interface ReferenceData {
  issues?: DevelopmentIssue[];
  strategies?: Strategy[];
  tacticsByStrategy?: Map<string, Tactic[]>;
  plansByTactic?: Map<string, Plan[]>;
}

/**
 * W113-BE-TEMPLATE — Server-rendered XLSX template generator
 * (CLAUDE.md §16 / §19).
 *
 * Why this lives on the backend:
 *   - §16.3: classification shape is owned by `DevelopmentPlan.reportFormat`.
 *     A client-side template builder cannot guarantee the column set
 *     matches the chosen plan's format. The server renders the template
 *     from `BookFormatResolver` so a STRATEGY_BASED template is never
 *     handed out for an ISSUE_BASED plan (or vice versa).
 *   - §19.3: a single bulk submit targets exactly ONE plan. The template
 *     is keyed on that plan; the parser may use the embedded `_meta`
 *     sheet to reject reused templates from another plan.
 *
 * Sheets emitted:
 *   1. `Template`        — header rows + budget-year columns. Matches
 *                          the FE wizard column order so the existing
 *                          parser keeps working without changes.
 *   2. `ข้อมูลอ้างอิง`   — reference values keyed to the plan's format.
 *                          STRATEGY_BASED: full Strategy → Tactic → Plan
 *                          triples sourced from the global tables (see
 *                          plan-scoping note below).
 *                          ISSUE_BASED: per-plan DevelopmentIssue rows.
 *   3. `_meta` (hidden)  — `{ developmentPlanId, reportFormat,
 *                          generatedAt }` so the parser can detect
 *                          template/plan mismatches.
 *
 * Plan-scoping note (STRATEGY_BASED reference sheet):
 *   `Strategy`, `Tactic`, `Plan`, and `PlanTactic` are GLOBAL lookups —
 *   they have no FK to `DevelopmentPlan`. The FE wizard at
 *   `frontend/src/page/project/Upload/UploadProject.tsx` already pulls
 *   the same global lists, so the template mirrors that contract exactly.
 *   A future wave that introduces plan-scoped strategies must update
 *   this method together with the wizard.
 */
@Injectable()
export class BulkUploadTemplateService {
  private readonly logger = new Logger(BulkUploadTemplateService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly bookFormatResolver: BookFormatResolver,
  ) {}

  /**
   * Build the XLSX buffer for `developmentPlanId`.
   *
   * Throws `NotFoundException` (via `BookFormatResolver`) when the plan
   * does not exist. The controller surfaces that as `404` to match the
   * task contract.
   */
  async buildTemplate(
    developmentPlanId: string,
  ): Promise<BulkUploadTemplateBuildResult> {
    const manager = this.dataSource.manager;

    // Step 1 — resolve format via the canonical resolver. Also doubles
    // as the existence check (resolver throws NotFoundException).
    const reportFormat = await this.bookFormatResolver.resolveByPlan(
      developmentPlanId,
      manager,
    );

    // Step 2 — load the plan body for budget-year columns.
    const plan = await manager.findOne(DevelopmentPlan, {
      where: { id: developmentPlanId },
      select: ['id', 'name', 'startYear', 'endYear'],
    });
    if (!plan) {
      // Resolver already guards this, but the type-narrow guard avoids
      // a non-null assertion below.
      throw new NotFoundException(
        `Development Plan ID not found: ${developmentPlanId}`,
      );
    }

    // Step 3 — derive budget-year list. Mirror the FE rule: only show
    // years from the current Thai budget year onward, capped by
    // `plan.endYear`. Falls back to the full plan span when the plan
    // is entirely in the past (defensive — bulk upload should not be
    // reachable for such a plan, but the template should still render).
    const currentBudgetYear = this.getCurrentBudgetYear();
    const startYear = Math.max(plan.startYear, currentBudgetYear);
    const endYear = plan.endYear;
    const budgetYears: number[] =
      endYear >= startYear
        ? Array.from(
            { length: endYear - startYear + 1 },
            (_, idx) => startYear + idx,
          )
        : Array.from(
            { length: Math.max(1, plan.endYear - plan.startYear + 1) },
            (_, idx) => plan.startYear + idx,
          );

    // Step 4 — load reference data once. Used both for the example
    // rows on the Template sheet AND for the full reference sheet.
    const refData = await this.loadReferenceData(
      reportFormat,
      developmentPlanId,
    );
    const exampleRows = this.buildExampleRows(
      reportFormat,
      budgetYears,
      refData,
    );

    // Step 5 — build the workbook.
    const workbook = XLSX.utils.book_new();
    const templateSheet = this.buildTemplateSheet(
      reportFormat,
      budgetYears,
      exampleRows,
    );
    XLSX.utils.book_append_sheet(workbook, templateSheet, 'Template');

    const referenceSheet = this.buildReferenceSheet(reportFormat, refData);
    XLSX.utils.book_append_sheet(
      workbook,
      referenceSheet,
      'ข้อมูลอ้างอิง',
    );

    const metaSheet = this.buildMetaSheet(developmentPlanId, reportFormat);
    XLSX.utils.book_append_sheet(workbook, metaSheet, '_meta');
    // Hide the metadata sheet so end-users don't try to edit it.
    if (workbook.Workbook?.Sheets) {
      const metaIdx = workbook.SheetNames.indexOf('_meta');
      if (metaIdx >= 0 && workbook.Workbook.Sheets[metaIdx]) {
        workbook.Workbook.Sheets[metaIdx].Hidden = 1;
      }
    } else {
      workbook.Workbook = {
        Sheets: workbook.SheetNames.map((name: string) => ({
          name,
          Hidden: name === '_meta' ? 1 : 0,
        })),
      };
    }

    const buffer: Buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    });

    const filename = this.buildFilename(developmentPlanId, reportFormat);

    return {
      buffer,
      filename,
      reportFormat,
      developmentPlanId,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Sheet builders
  // ──────────────────────────────────────────────────────────────────

  private buildTemplateSheet(
    reportFormat: ReportFormat,
    budgetYears: number[],
    exampleRows: (string | number)[][],
  ): any {
    const isIssueBased = reportFormat === ReportFormat.ISSUE_BASED;

    // Column ordering is intentionally aligned with
    // `UploadProject.tsx::handleDownloadTemplate` so the existing FE
    // parser keeps working without changes.
    const baseHeaders = isIssueBased
      ? [
          'ประเด็นการพัฒนา',
          'ชื่อโครงการ',
          'วัตถุประสงค์',
          'เป้าหมาย\n(ผลผลิตของโครงการ)',
          'ละติจูดเริ่มต้น',
          'ลองจิจูดเริ่มต้น',
          'ละติจูดสิ้นสุด',
          'ลองจิจูดสิ้นสุด',
        ]
      : [
          'ยุทธศาสตร์',
          'กลยุทธ์',
          'แผนงาน',
          'ชื่อโครงการ',
          'วัตถุประสงค์',
          'เป้าหมาย\n(ผลผลิตของโครงการ)',
          'ละติจูดเริ่มต้น',
          'ลองจิจูดเริ่มต้น',
          'ละติจูดสิ้นสุด',
          'ลองจิจูดสิ้นสุด',
        ];

    const tailHeaders = isIssueBased
      ? ['ผลที่คาดว่าจะได้รับ']
      : ['ตัวชี้วัด\n(KPI)', 'ผลที่คาดว่าจะได้รับ'];

    // Two-row header (row 1: section labels with budget-year merge,
    // row 2: per-year labels).
    const row1: (string | number)[] = [
      ...baseHeaders,
      'ปีงบประมาณ',
      ...budgetYears.slice(1).map(() => ''),
      ...tailHeaders,
    ];
    const row2: (string | number)[] = [
      ...baseHeaders.map(() => ''),
      ...budgetYears.map((y) => String(y)),
      ...tailHeaders.map(() => ''),
    ];

    // Headers + sample rows so users see what real data should look
    // like (column conventions, number formats, geo coordinates). Each
    // ชื่อโครงการ is prefixed with "ตัวอย่าง:" so users either delete the
    // row or replace it — the BE then validates the row normally.
    const sheet = XLSX.utils.aoa_to_sheet([row1, row2, ...exampleRows]);

    // Merge: base headers vertically, budget-year banner horizontally,
    // tail headers vertically.
    const merges: any[] = [];
    for (let col = 0; col < baseHeaders.length; col++) {
      merges.push({ s: { r: 0, c: col }, e: { r: 1, c: col } });
    }
    const budgetStartCol = baseHeaders.length;
    const budgetEndCol = baseHeaders.length + budgetYears.length - 1;
    if (budgetYears.length > 1) {
      merges.push({
        s: { r: 0, c: budgetStartCol },
        e: { r: 0, c: budgetEndCol },
      });
    }
    for (let i = 0; i < tailHeaders.length; i++) {
      const col = budgetEndCol + 1 + i;
      merges.push({ s: { r: 0, c: col }, e: { r: 1, c: col } });
    }
    sheet['!merges'] = merges;

    // Approximate column widths (xlsx uses character units).
    const baseWidths = isIssueBased
      ? [30, 30, 40, 40, 18, 18, 18, 18]
      : [24, 24, 24, 30, 40, 40, 18, 18, 18, 18];
    const tailWidths = isIssueBased ? [40] : [40, 40];
    sheet['!cols'] = [
      ...baseWidths.map((w) => ({ wch: w })),
      ...budgetYears.map(() => ({ wch: 18 })),
      ...tailWidths.map((w) => ({ wch: w })),
    ];

    sheet['!rows'] = [
      { hpt: 30 },
      { hpt: 24 },
      ...exampleRows.map(() => ({ hpt: 40 })),
    ];

    return sheet;
  }

  /**
   * Build 2 example rows shown directly under the header on the Template
   * sheet. Each example uses real Strategy/Tactic/Plan or DevelopmentIssue
   * names so the dropdown bindings make sense, and prefixes ชื่อโครงการ
   * with "ตัวอย่าง:" so the user knows to delete or overwrite it. Sample
   * coordinates default to Nakhon Ratchasima province (§13.5 boundary).
   */
  private buildExampleRows(
    reportFormat: ReportFormat,
    budgetYears: number[],
    refData: ReferenceData,
  ): (string | number)[][] {
    const samples = [
      {
        title: 'ตัวอย่าง: ปรับปรุงถนนลาดยาง สายบ้านโนนสำราญ',
        objective: 'เพื่อให้ประชาชนสัญจรได้สะดวก ปลอดภัย ลดอุบัติเหตุ',
        target: 'ลาดยางทางแอสฟัลต์คอนกรีต ระยะทาง 500 เมตร',
        startLat: 14.9799,
        startLng: 102.0978,
        endLat: 14.9821,
        endLng: 102.0995,
        kpi: 'ระยะทางถนนที่ลาดยาง (เมตร)',
        expected: 'ประชาชนสัญจรสะดวก ปลอดภัย ลดอุบัติเหตุทางถนน',
        budget: 500_000,
      },
      {
        title: 'ตัวอย่าง: ขุดลอกคลองส่งน้ำสายหลัก',
        objective: 'เพื่อเพิ่มประสิทธิภาพการระบายน้ำ บรรเทาปัญหาน้ำท่วม',
        target: 'ขุดลอกความลึก 2 เมตร ระยะทาง 1 กิโลเมตร',
        startLat: 15.0345,
        startLng: 102.1234,
        endLat: 15.0388,
        endLng: 102.1289,
        kpi: 'ปริมาตรดินที่ขุดลอก (ลูกบาศก์เมตร)',
        expected: 'บรรเทาปัญหาน้ำท่วมในพื้นที่ในฤดูฝน',
        budget: 750_000,
      },
    ];

    const isIssueBased = reportFormat === ReportFormat.ISSUE_BASED;

    // Pick a real reference value if the plan has any; otherwise use
    // an instruction placeholder.
    const issueName =
      refData.issues && refData.issues.length > 0
        ? refData.issues[0].name
        : '(เลือกจากดรอปดาวน์ในชีต "ข้อมูลอ้างอิง")';
    const firstTriple = this.firstStrategyTriple(refData);

    return samples.map((s, idx) => {
      // Budget vector: spread across years to show users they may fill
      // multiple cells. First sample loads year 1; second loads year 2
      // if available, else year 1.
      const budgetCells: (string | number)[] = budgetYears.map((_, i) => {
        if (idx === 0 && i === 0) return s.budget;
        if (idx === 1 && i === Math.min(1, budgetYears.length - 1)) return s.budget;
        return '';
      });

      if (isIssueBased) {
        return [
          issueName,
          s.title,
          s.objective,
          s.target,
          s.startLat,
          s.startLng,
          s.endLat,
          s.endLng,
          ...budgetCells,
          s.expected,
        ];
      }
      return [
        firstTriple.strategy,
        firstTriple.tactic,
        firstTriple.plan,
        s.title,
        s.objective,
        s.target,
        s.startLat,
        s.startLng,
        s.endLat,
        s.endLng,
        ...budgetCells,
        s.kpi,
        s.expected,
      ];
    });
  }

  private firstStrategyTriple(refData: ReferenceData): {
    strategy: string;
    tactic: string;
    plan: string;
  } {
    const placeholder = '(เลือกจากดรอปดาวน์ในชีต "ข้อมูลอ้างอิง")';
    if (!refData.strategies || refData.strategies.length === 0) {
      return { strategy: placeholder, tactic: placeholder, plan: placeholder };
    }
    for (const s of refData.strategies) {
      const tactics = refData.tacticsByStrategy?.get(s.id) ?? [];
      for (const t of tactics) {
        const plans = refData.plansByTactic?.get(t.id) ?? [];
        if (plans.length > 0) {
          return { strategy: s.name, tactic: t.name, plan: plans[0].name };
        }
      }
    }
    // Fall back to first strategy with empty downstream.
    const s = refData.strategies[0];
    return { strategy: s.name, tactic: placeholder, plan: placeholder };
  }

  /**
   * Load the data needed for both the example rows and the reference
   * sheet in ONE pass — avoids re-querying the same tables twice.
   */
  private async loadReferenceData(
    reportFormat: ReportFormat,
    developmentPlanId: string,
  ): Promise<ReferenceData> {
    if (reportFormat === ReportFormat.ISSUE_BASED) {
      const issues = await this.dataSource
        .getRepository(DevelopmentIssue)
        .createQueryBuilder('di')
        .where('di.development_plan_id = :id', { id: developmentPlanId })
        .andWhere('di.deleted_at IS NULL')
        .orderBy('di.sort_order', 'ASC')
        .addOrderBy('di.created_at', 'ASC')
        .getMany();
      return { issues };
    }

    // STRATEGY_BASED — global Strategy / Tactic / Plan triples.
    // (Plan-scoping note in the class JSDoc above.)
    const strategies = await this.dataSource
      .getRepository(Strategy)
      .createQueryBuilder('s')
      .where('s.deleted_at IS NULL')
      .orderBy('s.id', 'ASC')
      .getMany();

    const tactics = await this.dataSource
      .getRepository(Tactic)
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.strategy', 'strategy')
      .where('t.deleted_at IS NULL')
      .orderBy('t.id', 'ASC')
      .getMany();

    const planTactics = await this.dataSource
      .getRepository(PlanTactic)
      .createQueryBuilder('pt')
      .leftJoinAndSelect('pt.plan', 'plan')
      .leftJoinAndSelect('pt.tactic', 'tactic')
      .getMany();

    const plansByTactic = new Map<string, Plan[]>();
    for (const pt of planTactics) {
      if (!pt.plan || !pt.tactic) continue;
      if (pt.plan.deletedAt) continue;
      const list = plansByTactic.get(pt.tactic.id) ?? [];
      list.push(pt.plan);
      plansByTactic.set(pt.tactic.id, list);
    }

    const tacticsByStrategy = new Map<string, Tactic[]>();
    for (const t of tactics) {
      if (!t.strategy) continue;
      const list = tacticsByStrategy.get(t.strategy.id) ?? [];
      list.push(t);
      tacticsByStrategy.set(t.strategy.id, list);
    }

    return { strategies, tacticsByStrategy, plansByTactic };
  }

  private buildReferenceSheet(
    reportFormat: ReportFormat,
    refData: ReferenceData,
  ): any {
    if (reportFormat === ReportFormat.ISSUE_BASED) {
      const aoa: (string | number)[][] = [['ประเด็นการพัฒนา']];
      for (const issue of refData.issues ?? []) {
        aoa.push([issue.name]);
      }
      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      sheet['!cols'] = [{ wch: 60 }];
      return sheet;
    }

    const aoa: (string | number)[][] = [['ยุทธศาสตร์', 'กลยุทธ์', 'แผนงาน']];
    for (const s of refData.strategies ?? []) {
      const sTactics = refData.tacticsByStrategy?.get(s.id) ?? [];
      if (sTactics.length === 0) {
        aoa.push([s.name, '', '']);
        continue;
      }
      for (const t of sTactics) {
        const tPlans = refData.plansByTactic?.get(t.id) ?? [];
        if (tPlans.length === 0) {
          aoa.push([s.name, t.name, '']);
          continue;
        }
        for (const p of tPlans) {
          aoa.push([s.name, t.name, p.name]);
        }
      }
    }

    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet['!cols'] = [{ wch: 40 }, { wch: 40 }, { wch: 40 }];
    return sheet;
  }

  private buildMetaSheet(
    developmentPlanId: string,
    reportFormat: ReportFormat,
  ): any {
    const aoa: (string | number)[][] = [
      ['key', 'value'],
      ['developmentPlanId', developmentPlanId],
      ['reportFormat', reportFormat],
      ['generatedAt', new Date().toISOString()],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet['!cols'] = [{ wch: 24 }, { wch: 60 }];
    return sheet;
  }

  // ──────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Mirrors the FE rule in `UploadProject.tsx::handleDownloadTemplate`:
   * Thai budget year transitions on October 1, so months 10-12 already
   * belong to the next budget year.
   */
  private getCurrentBudgetYear(): number {
    const now = new Date();
    const calendarYear = now.getFullYear() + 543;
    const month = now.getMonth() + 1;
    return month >= 10 ? calendarYear + 1 : calendarYear;
  }

  private buildFilename(
    developmentPlanId: string,
    reportFormat: ReportFormat,
  ): string {
    const shortId = developmentPlanId.slice(0, 8);
    const fmt =
      reportFormat === ReportFormat.ISSUE_BASED ? 'issue' : 'strategy';
    return `bulk-upload-template-${shortId}-${fmt}.xlsx`;
  }
}
