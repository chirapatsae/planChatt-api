import { Injectable } from '@nestjs/common';
import { SmartApproveRequestDto } from './dto/smart-approve.dto';
import { SmartApproveReferenceService } from './smart-approve-reference.service';
import { GeoBoundaryService } from './geo-boundary.service';

export type SmartApproveStatus = 'ผ่าน' | 'ควรปรับปรุง' | 'ไม่ผ่าน';

export interface SmartApproveCategoryResult {
  status: SmartApproveStatus;
  details: string;
  suggestions: string[];
}

export interface SmartApproveEvaluationResponse {
  summary: {
    overallResult: SmartApproveStatus;
    reason: string;
    suggestedActions: string[];
  };
  categories: {
    strategy: SmartApproveCategoryResult;
    projectInfo: SmartApproveCategoryResult;
    location: SmartApproveCategoryResult;
    budget: SmartApproveCategoryResult;
    indicators: SmartApproveCategoryResult;
  };
}

interface PrecheckResult {
  response: SmartApproveEvaluationResponse;
  shouldUseLLM: boolean;
}

@Injectable()
export class SmartApprovePrecheckService {
  constructor(
    private readonly referenceService: SmartApproveReferenceService,
    private readonly geoBoundaryService: GeoBoundaryService,
  ) { }

  async evaluate(dto: SmartApproveRequestDto): Promise<PrecheckResult> {
    const categories: SmartApproveEvaluationResponse['categories'] = {
      strategy: await this.evaluateStrategy(dto),
      projectInfo: await this.evaluateProjectInfo(dto),
      location: await this.evaluateLocation(dto),
      budget: await this.evaluateBudget(dto),
      indicators: await this.evaluateIndicators(dto),
    };

    const worstStatus = this.computeOverallStatus(categories);
    const suggestedActions = this.collectSuggestedActions(categories);

    const response: SmartApproveEvaluationResponse = {
      summary: {
        overallResult: worstStatus,
        reason: this.buildSummaryReason(categories, worstStatus),
        suggestedActions,
      },
      categories,
    };

    const shouldUseLLM = this.determineNeedForLLM(categories, dto);

    return { response, shouldUseLLM };
  }

  private async evaluateStrategy(
    dto: SmartApproveRequestDto,
  ): Promise<SmartApproveCategoryResult> {
    const { strategyName, tacticName, planName } = dto;
    const issues: string[] = [];
    const suggestions: string[] = [];
    let hasCriticalIssue = false;

    const strategy = await this.referenceService.findStrategyByName(strategyName);
    if (!strategy) {
      hasCriticalIssue = true;
      issues.push(
        `ไม่พบชื่อยุทธศาสตร์ "${strategyName}" ในฐานข้อมูลอ้างอิง`,
      );
      suggestions.push(
        'ตรวจสอบชื่อยุทธศาสตร์ให้ตรงกับข้อมูลที่เผยแพร่ในระบบ (เว้นวรรคและเลขลำดับต้องตรงกัน)',
      );
    }

    const tactic = await this.referenceService.findTacticByName(tacticName);
    if (!tactic) {
      hasCriticalIssue = true;
      issues.push(`ไม่พบชื่อกลยุทธ์ "${tacticName}" ในฐานข้อมูลอ้างอิง`);
      suggestions.push(
        'ตรวจสอบชื่อกลยุทธ์ให้ตรงกับรายการที่กำหนดไว้ในยุทธศาสตร์แต่ละด้าน',
      );
    }

    const plan = await this.referenceService.findPlanByName(planName);
    if (!plan) {
      hasCriticalIssue = true;
      issues.push(`ไม่พบชื่อแผนงาน "${planName}" ในฐานข้อมูลอ้างอิง`);
      suggestions.push(
        'ตรวจสอบชื่อแผนงานให้ตรงกับรายการที่ระบบสนับสนุน',
      );
    }

    if (strategy && tactic && tactic.strategy?.id !== strategy.id) {
      // Note: Tactic entity has 'strategy' relation, so we check tactic.strategy.id
      hasCriticalIssue = true;
      const expectedStrategy = await this.referenceService.getStrategyById(
        tactic.strategy?.id ?? '',
      );
      issues.push(
        `กลยุทธ์ "${tacticName}" อยู่ภายใต้ยุทธศาสตร์ "${expectedStrategy?.name ?? tactic.strategy?.id}" ไม่ตรงกับ "${strategyName}"`,
      );
      const validTactics = (await this.referenceService
        .getTacticsForStrategy(strategy.id))
        .map((item) => item.name);

      if (validTactics.length > 0) {
        suggestions.push(
          `เลือกกลยุทธ์ที่อยู่ในยุทธศาสตร์ "${strategy.name}": ${validTactics.join(', ')}`,
        );
      } else {
        suggestions.push(
          `เลือกกลยุทธ์ที่อยู่ภายใต้ยุทธศาสตร์ "${strategy.name}"`,
        );
      }
    }

    if (plan && tactic) {
      const relationIsValid = await this.referenceService.isPlanLinkedToTactic(
        plan.id,
        tactic.id,
      );
      if (!relationIsValid) {
        hasCriticalIssue = true;
        const validPlans = (await this.referenceService
          .getPlansForTactic(tactic.id))
          .map((item) => item.name);

        issues.push(
          `แผนงาน "${planName}" ไม่ได้เชื่อมกับกลยุทธ์ "${tacticName}" ตามฐานข้อมูล`,
        );
        if (validPlans.length > 0) {
          suggestions.push(
            `เลือกแผนงานที่รองรับกลยุทธ์ "${tacticName}": ${validPlans.join(', ')}`,
          );
        } else {
          suggestions.push(
            `ตรวจสอบโครงสร้างความเชื่อมโยงของกลยุทธ์ "${tacticName}" กับแผนงานที่ระบบกำหนด`,
          );
        }
      }
    }

    if (!hasCriticalIssue && suggestions.length === 0) {
      return {
        status: 'ผ่าน',
        details:
          'ยุทธศาสตร์ กลยุทธ์ และแผนงานที่เลือกตรงกับข้อมูลอ้างอิงและเชื่อมโยงกันถูกต้อง',
        suggestions: [],
      };
    }

    if (hasCriticalIssue) {
      return {
        status: 'ไม่ผ่าน',
        details: issues.join(' / '),
        suggestions,
      };
    }

    return {
      status: 'ควรปรับปรุง',
      details: issues.join(' / '),
      suggestions,
    };
  }

  private evaluateProjectInfo(
    dto: SmartApproveRequestDto,
  ): SmartApproveCategoryResult {
    // ไม่ต้อง precheck ส่งไปให้ AI ตรวจสอบเลย
    return {
      status: 'ผ่าน',
      details: 'รอการประเมินจาก AI',
      suggestions: [],
    };
  }

  private async evaluateLocation(
    dto: SmartApproveRequestDto,
  ): Promise<SmartApproveCategoryResult> {
    const { project } = dto;
    const suggestions: string[] = [];

    if (
      project.startLat === undefined ||
      project.startLng === undefined ||
      Number.isNaN(project.startLat) ||
      Number.isNaN(project.startLng)
    ) {
      suggestions.push(
        'กรุณาระบุพิกัดตำแหน่งกิจกรรม (Latitude/Longitude) ให้ครบถ้วนเพื่อใช้ตรวจสอบพื้นที่รับผิดชอบ',
      );
      return {
        status: 'ควรปรับปรุง',
        details: 'ยังไม่มีข้อมูลพิกัดที่สามารถใช้ตรวจสอบพื้นที่ได้',
        suggestions,
      };
    }

    const localOrg = await this.referenceService.getLocalOrganizationById(
      project.localOrganizationId,
    );
    if (project.localOrganizationId && !localOrg) {
      suggestions.push(
        'รหัสองค์กรปกครองส่วนท้องถิ่นไม่ตรงกับฐานข้อมูล กรุณาตรวจสอบอีกครั้ง',
      );
    }

    const amphoeId =
      project.amphoeId !== undefined && project.amphoeId !== null
        ? project.amphoeId
        : localOrg?.amphoe?.id ? Number(localOrg.amphoe.id) : undefined; // Access amphoe relation from localOrg

    if (amphoeId === undefined || amphoeId === null) {
      // ไม่มีรหัสอำเภอ ไม่สามารถตรวจสอบพื้นที่ได้ แต่ถือว่า pass
      return {
        status: suggestions.length > 0 ? 'ควรปรับปรุง' : 'ผ่าน',
        details:
          'มีการระบุพิกัดเริ่มต้นของโครงการ แต่ไม่ได้ระบุรหัสอำเภอ จึงไม่สามารถตรวจสอบพื้นที่ได้โดยอัตโนมัติ',
        suggestions,
      };
    } else {
      const isInside = this.geoBoundaryService.isPointInsideAmphoe(
        project.startLat,
        project.startLng,
        amphoeId,
      );

      if (isInside === false) {
        const amphoe = await this.referenceService.getAmphoeById(amphoeId);
        return {
          status: 'ควรปรับปรุง',
          details: `พิกัดโครงการอยู่นอกพื้นที่อำเภอ${amphoe ? ` ${amphoe.name}` : ''}ที่ระบุ กรุณาตรวจสอบหรือแก้ไขข้อมูลพิกัด`,
          suggestions: [
            'ตรวจสอบหรือแก้ไขพิกัดให้สอดคล้องกับพื้นที่รับผิดชอบของอำเภอที่เลือก',
          ],
        };
      }

      if (isInside === true) {
        const amphoe = await this.referenceService.getAmphoeById(amphoeId);
        return {
          status: suggestions.length > 0 ? 'ควรปรับปรุง' : 'ผ่าน',
          details: `พิกัดโครงการอยู่ในพื้นที่อำเภอ${amphoe ? ` ${amphoe.name}` : ''}ที่ระบุ`,
          suggestions: suggestions.length > 0 ? suggestions : [],
        };
      }

      if (isInside === null) {
        suggestions.push(
          'ไม่พบข้อมูลขอบเขตพื้นที่ของอำเภอที่ระบุ กรุณาตรวจสอบรหัสอำเภอหรือไฟล์ขอบเขตพื้นที่',
        );
      }
    }

    return {
      status: suggestions.length > 0 ? 'ควรปรับปรุง' : 'ผ่าน',
      details:
        'มีการระบุพิกัดเริ่มต้นของโครงการ สามารถนำไปตรวจสอบกับพื้นที่รับผิดชอบของหน่วยงานได้',
      suggestions: suggestions.length > 0 ? suggestions : [],
    };
  }

  private evaluateBudget(
    dto: SmartApproveRequestDto,
  ): SmartApproveCategoryResult {
    // ไม่ต้อง precheck ส่งไปให้ AI ตรวจสอบเลย
    return {
      status: 'ผ่าน',
      details: 'รอการประเมินจาก AI',
      suggestions: [],
    };
  }

  private evaluateIndicators(
    dto: SmartApproveRequestDto,
  ): SmartApproveCategoryResult {
    // ไม่ต้อง precheck ส่งไปให้ AI ตรวจสอบเลย
    return {
      status: 'ผ่าน',
      details: 'รอการประเมินจาก AI',
      suggestions: [],
    };
  }

  private computeOverallStatus(
    categories: SmartApproveEvaluationResponse['categories'],
  ): SmartApproveStatus {
    const statuses = Object.values(categories).map((c) => c.status);
    if (statuses.includes('ไม่ผ่าน')) {
      return 'ไม่ผ่าน';
    }
    if (statuses.includes('ควรปรับปรุง')) {
      return 'ควรปรับปรุง';
    }
    return 'ผ่าน';
  }

  private collectSuggestedActions(
    categories: SmartApproveEvaluationResponse['categories'],
  ): string[] {
    const actions = new Set<string>();
    Object.values(categories).forEach((category) => {
      category.suggestions.forEach((suggestion) => actions.add(suggestion));
    });
    return Array.from(actions);
  }

  private buildSummaryReason(
    categories: SmartApproveEvaluationResponse['categories'],
    overall: SmartApproveStatus,
  ): string {
    if (overall === 'ผ่าน') {
      return 'โครงการมีข้อมูลครบถ้วนตามเกณฑ์การตรวจสอบเบื้องต้น';
    }

    const problematicCategories = Object.entries(categories)
      .filter(([, value]) => value.status !== 'ผ่าน')
      .map(([key]) => this.mapCategoryKeyToLabel(key));

    return `พบประเด็นต้องพิจารณาเพิ่มเติมในหมวด: ${problematicCategories.join(
      ', ',
    )}`;
  }

  private determineNeedForLLM(
    categories: SmartApproveEvaluationResponse['categories'],
    dto: SmartApproveRequestDto,
  ): boolean {
    // เรียกใช้ AI สำหรับ 3 หมวด: projectInfo, budget, indicators
    // ส่งไปให้ AI ตรวจสอบเลย ไม่ต้อง precheck

    const { project } = dto;

    // ตรวจสอบว่ามีข้อมูลใน 3 หมวดนี้หรือไม่
    const hasProjectInfo = !!(
      project.title?.trim() ||
      project.objective?.trim() ||
      project.goal?.trim()
    );

    const hasBudget = !!(project.budgets && project.budgets.length > 0);

    const hasIndicators = !!(
      project.indicator?.trim() || project.expected?.trim()
    );

    // เรียกใช้ AI เมื่อมีข้อมูลในอย่างน้อย 1 หมวด
    return hasProjectInfo || hasBudget || hasIndicators;
  }

  private mapCategoryKeyToLabel(key: string): string {
    const mapping: Record<string, string> = {
      strategy: 'ยุทธศาสตร์และกลยุทธ์',
      projectInfo: 'ข้อมูลโครงการ',
      location: 'พิกัด',
      budget: 'งบประมาณ',
      indicators: 'ตัวชี้วัดและผลที่คาดว่าจะได้รับ',
    };
    return mapping[key] || key;
  }
}

