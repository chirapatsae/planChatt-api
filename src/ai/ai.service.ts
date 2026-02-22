import { Injectable, InternalServerErrorException, HttpException } from '@nestjs/common';
import { OpenAI } from 'openai';
import { AiUsageQuotasService } from 'src/ai-usage-quotas/ai-usage-quotas.service';
import { RegenerateFieldDto } from './dto/generate-project.dto';
import { SmartApproveRequestDto } from './dto/smart-approve.dto';
import {
  SmartApproveEvaluationResponse,
  SmartApprovePrecheckService,
} from './smart-approve-precheck.service';
import { calculateAiCost } from './utils/cost-calculator';

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor(
    private readonly precheckService: SmartApprovePrecheckService,
    private readonly aiUsageQuotasService: AiUsageQuotasService,
  ) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateProjectDetail(
    strategy: string,
    tactic: string,
    plan: string,
    userId: string, // Add userId
    userPrompt?: string,
  ) {
    const systemPrompt = `คุณเป็นเจ้าหน้าที่วางแผนพัฒนาท้องถิ่นผู้เชี่ยวชาญ มีหน้าที่ให้คำแนะนำและร่างรายละเอียดโครงการโดยใช้ภาษาราชการไทยที่ถูกต้องและสละสลวย ให้รายละเอียดที่ครบถ้วน ชัดเจน และครอบคลุมทุกด้านของโครงการ`;
    let mainPrompt = `จากแผนงาน "${plan}", ยุทธศาสตร์ "${strategy}", และกลยุทธ์ "${tactic}" โปรดช่วยเสนอรายละเอียดโครงการในรูปแบบต่อไปนี้:

**ชื่อโครงการ:**
[ชื่อโครงการที่เหมาะสมและสอดคล้องกับแผนงาน ยุทธศาสตร์ และกลยุทธ์]

**วัตถุประสงค์:**
[วัตถุประสงค์ของโครงการที่ชัดเจน ครอบคลุม และมีรายละเอียดพอสมควร โดยระบุเหตุผลและความจำเป็นของโครงการ]

**เป้าหมาย:**
[เป้าหมายของโครงการที่วัดผลได้ มีระยะเวลาที่ชัดเจน และครอบคลุมกลุ่มเป้าหมายที่เกี่ยวข้อง]

**ผลที่คาดว่าจะได้รับ:**
[ผลลัพธ์ที่คาดหวังจากโครงการ ทั้งผลกระทบทางตรงและทางอ้อม พร้อมรายละเอียดของผลประโยชน์ที่จะเกิดขึ้น]

**ตัวชี้วัด:**
[ตัวชี้วัดความสำเร็จที่วัดผลได้ มีความชัดเจน และครอบคลุมทั้งด้านปริมาณและคุณภาพ]

**หมายเหตุ:** โปรดตอบในรูปแบบที่กำหนดเท่านั้น ให้รายละเอียดที่ครบถ้วนและชัดเจน`;

    if (userPrompt?.trim()) {
      mainPrompt += `\n\nโดยมีรายละเอียดหรือเงื่อนไขเพิ่มเติมที่ต้องพิจารณาเป็นพิเศษ ดังนี้:\n"${userPrompt}"`;
    }

    mainPrompt += `\n\n**คำแนะนำเพิ่มเติม:** โปรดให้รายละเอียดที่ครบถ้วนและชัดเจนสำหรับแต่ละหัวข้อ โดยไม่ต้องกังวลเรื่องความยาวของคำตอบ`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.7,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: mainPrompt },
        ],
      });

      // Calculate and deduct cost
      if (completion.usage) {
        const costUsd = calculateAiCost('gpt-4o', completion.usage);
        await this.aiUsageQuotasService.checkAndLogUsage(userId, costUsd, {
          usageType: 'PROJECT_GENERATION',
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
        });
      }

      return {
        content: completion.choices[0].message.content,
        usage: completion.usage,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      // ...
      console.error('Error calling OpenAI API:', error);
      throw new InternalServerErrorException(
        'เกิดข้อผิดพลาดในการประมวลผลข้อมูลกับ AI',
      );
    }
  }

  async regenerateField(dto: RegenerateFieldDto, userId: string) {
    const {
      strategy,
      tactic,
      plan,
      currentProjectData,
      fieldToRegenerate,
      modificationPrompt,
    } = dto;

    const fieldNameMapping: { [key: string]: string } = {
      title: 'ชื่อโครงการ',
      objective: 'วัตถุประสงค์',
      goal: 'เป้าหมาย',
      expected: 'ผลที่คาดว่าจะได้รับ',
      indicator: 'ตัวชี้วัด',
    };

    const targetFieldName =
      fieldNameMapping[fieldToRegenerate] || fieldToRegenerate;
    const prompt = `
                คุณเป็นเจ้าหน้าที่วางแผนพัฒนาท้องถิ่นผู้เชี่ยวชาญ ที่กำลังช่วยแก้ไขร่างโครงการ

                **นี่คือรายละเอียดโครงการปัจจุบัน:**
                - ชื่อโครงการ: ${currentProjectData.title || '(ไม่มีข้อมูล)'}
                - วัตถุประสงค์: ${currentProjectData.objective || '(ไม่มีข้อมูล)'}
                - เป้าหมาย: ${currentProjectData.goal || '(ไม่มีข้อมูล)'}
                - ผลที่คาดว่าจะได้รับ: ${currentProjectData.expected || '(ไม่มีข้อมูล)'}
                - ตัวชี้วัด: ${currentProjectData.indicator || '(ไม่มีข้อมูล)'}

                **โครงการนี้อยู่ภายใต้บริบทดั้งเดิมคือ:**
                - แผนงาน: ${plan}
                - ยุทธศาสตร์: ${strategy}
                - กลยุทธ์: ${tactic}

                ---
                **ภารกิจของคุณ:**
                โปรดช่วยร่าง "${targetFieldName}" ของโครงการนี้ขึ้นมาใหม่ **เพียงหัวข้อเดียวเท่านั้น** โดยยึดตามบริบททั้งหมด และทำตามคำสั่งเพิ่มเติมนี้: "${modificationPrompt}"

                **ข้อกำหนดการตอบ:**
                - ให้คำตอบเป็นข้อความของ "${targetFieldName}" ใหม่เท่านั้น
                - ไม่ต้องมีคำว่า "${targetFieldName}:" นำหน้า
                - ไม่ต้องมีหัวข้ออื่นๆ หรือคำอธิบายใดๆ เพิ่มเติม
                `;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.6,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content:
              'คุณคือผู้ช่วยวางแผนพัฒนาท้องถิ่นที่มีความเชี่ยวชาญและตอบคำถามอย่างตรงไปตรงมาตามคำสั่ง',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // Calculate and deduct cost
      if (completion.usage) {
        const costUsd = calculateAiCost('gpt-4o', completion.usage);
        await this.aiUsageQuotasService.checkAndLogUsage(userId, costUsd, {
          usageType: 'FIELD_REGENERATION',
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
        });
      }

      if (completion.choices[0].message?.content) {
        return {
          content: completion.choices[0].message.content.trim(),
          usage: completion.usage,
        };
      }
      throw new InternalServerErrorException(
        'AI response is invalid or incomplete.',
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      console.error('Error calling OpenAI API for regeneration:', error);
      throw new InternalServerErrorException(
        'เกิดข้อผิดพลาดในการสร้างข้อมูลใหม่จาก AI',
      );
    }
  }

  async analyzeProjectForSmartApprove(
    dto: SmartApproveRequestDto,
    userId: string,
  ): Promise<SmartApproveEvaluationResponse> {


    const precheck = await this.precheckService.evaluate(dto);

    if (!precheck.shouldUseLLM) {
      return precheck.response;
    }

    const aiResult = await this.executeLlmSmartApproveAnalysis(
      dto,
      precheck.response,
      userId,
    );

    return this.mergePrecheckAndAi(precheck.response, aiResult);
  }

  private async executeLlmSmartApproveAnalysis(
    dto: SmartApproveRequestDto,
    precheck: SmartApproveEvaluationResponse,
    userId: string,
  ): Promise<SmartApproveEvaluationResponse> {
    const {
      strategyName,
      tacticName,
      planName,
      project,
      additionalContext,
    } = dto;

    const systemPrompt =
      'คุณคือนักวิเคราะห์นโยบายและแผนขององค์การบริหารส่วนท้องถิ่น (อบจ.) มีหน้าที่ประเมินโครงการตามกรอบราชการไทยอย่างรอบคอบและเป็นมืออาชีพ กำหนดผลการประเมินในรูปแบบ JSON ตาม schema ที่กำหนดเท่านั้น';

    const budgetLines = (project.budgets || [])
      .map(
        (budget) =>
          `- ปีงบประมาณ ${budget.year}: ${budget.quantity.toFixed(2)} บาท`,
      )
      .join('\n');

    const locationTextParts: string[] = [];
    if (project.startLat !== undefined && project.startLng !== undefined) {
      locationTextParts.push(
        `พิกัดเริ่มต้น: (${project.startLat}, ${project.startLng})`,
      );
    }
    if (project.endLat !== undefined && project.endLng !== undefined) {
      locationTextParts.push(
        `พิกัดสิ้นสุด: (${project.endLat}, ${project.endLng})`,
      );
    }

    const locationText =
      locationTextParts.length > 0
        ? locationTextParts.join('\n')
        : 'ไม่มีข้อมูลพิกัดที่ส่งมา';

    const projectDetails = `ข้อมูลโครงการ
- ชื่อโครงการ: ${project.title}
- วัตถุประสงค์: ${project.objective}
- เป้าหมาย: ${project.goal}
- ผลที่คาดว่าจะได้รับ: ${project.expected ?? 'ไม่ระบุ'}
- ตัวชี้วัด: ${project.indicator ?? 'ไม่ระบุ'}
- งบประมาณ:\n${budgetLines || '- ไม่ระบุ'}
- ข้อมูลพื้นที่:\n${locationText}`;

    const referenceDetails = `บริบทการอ้างอิง
- ยุทธศาสตร์ที่เลือก: ${strategyName}
- กลยุทธ์ที่เลือก: ${tacticName}
- แผนงานที่เลือก: ${planName}`;

    const precheckSummary = `ผลการตรวจสอบเบื้องต้นจากระบบ (ไม่ต้องปรับซ้ำ หากเห็นว่าเหมาะสมแล้ว):
${JSON.stringify(precheck, null, 2)}`;

    const instructions = `โปรดประเมินโครงการโดยยึดตามเกณฑ์ต่อไปนี้ (เฉพาะ 3 หมวดที่ต้องประเมิน):

**1. หมวด "ข้อมูลโครงการ" (projectInfo):**
- ตรวจสอบว่าชื่อโครงการ วัตถุประสงค์ และเป้าหมาย สอดคล้องกับยุทธศาสตร์/กลยุทธ์/แผนงานที่เลือกหรือไม่
- ตรวจสอบว่าวัตถุประสงค์และเป้าหมายสอดคล้องกับชื่อโครงการหรือไม่
- ประเมินความชัดเจนและความครอบคลุมของเนื้อหาโครงการ
- ประเมินว่าข้อมูลเพียงพอหรือไม่เพียงพอและสื่อความหมายหรือไม่
- ให้สถานะ "ผ่าน" หากข้อมูลเพียงพอ สอดคล้องและชัดเจน, "ควรปรับปรุง" หากข้อมูลไม่เพียงพอ ไม่ชัดเจน หรือต้องปรับแก้, "ไม่ผ่าน" หากไม่สอดคล้องอย่างชัดเจนหรือไม่สื่อความหมาย

**2. หมวด "งบประมาณ" (budget):**
- ตรวจสอบความเหมาะสม ความสอดคล้อง และความเพียงพอของงบประมาณเมื่อเทียบกับกิจกรรมของโครงการ
- เน้นพิจารณาที่ "ความสมเหตุสมผลของยอดงบประมาณรวม" ว่าเพียงพอต่อการดำเนินโครงการให้สำเร็จหรือไม่
- หากงบประมาณไม่สอดคล้อง (เช่น น้อยเกินไปจนไม่สามารถทำจริงได้ หรือมากเกินความจำเป็น) ให้ระบุเหตุผลความไม่สอดคล้องนั้น เช่น "งบประมาณน้อยกว่าเกณฑ์เฉลี่ยของกิจกรรมนี้" หรือ "ไม่สอดคล้องกับขอบเขตงาน"
- **ห้าม** แนะนำให้ "ระบุรายละเอียดการใช้จ่ายงบประมาณในแต่ละกิจกรรม" หรือ "แจกแจงงบย่อย" หากยอดงบประมาณรวมดูสมเหตุสมผลและเป็นไปได้แล้ว
- ให้สถานะ "ผ่าน" หากประเมินแล้วว่างบประมาณมีความสมเหตุสมผลและเพียงพอต่อการดำเนินงาน
- ให้สถานะ "ควรปรับปรุง" หรือ "ไม่ผ่าน" เฉพาะกรณีที่ตัวเลขงบประมาณดูผิดปกติ ไม่สมจริง หรือไม่สัมพันธ์กับกิจกรรมอย่างชัดเจนเท่านั้น

**3. หมวด "ตัวชี้วัดและผลที่คาดว่าจะได้รับ" (indicators):**
- ตรวจสอบว่าตัวชี้วัดและผลที่คาดว่าจะได้รับสอดคล้องกับเป้าหมายและวัตถุประสงค์ของโครงการหรือไม่
- ประเมินความชัดเจนและความสามารถในการวัดผล
- ประเมินว่าข้อมูลตัวชี้วัดและผลที่คาดว่าจะได้รับเพียงพอหรือไม่เพียงพอ ไม่สื่อความหมายหรือไม่
- ให้สถานะ "ผ่าน" หากข้อมูลเพียงพอ สอดคล้องและชัดเจน, "ควรปรับปรุง" หากข้อมูลไม่เพียงพอ ไม่ชัดเจน หรือต้องปรับแก้, "ไม่ผ่าน" หากไม่สอดคล้องอย่างชัดเจนหรือไม่สื่อความหมาย

**หมายเหตุสำคัญ:**
- หมวด "ยุทธศาสตร์และกลยุทธ์" (strategy) และ "พิกัด" (location) ไม่ต้องประเมิน ให้ใช้ผลจาก precheck ที่ส่งมาเท่านั้น
- ค่า status ทุกหมวดต้องอยู่ในชุด {"ผ่าน", "ควรปรับปรุง", "ไม่ผ่าน"}
- สรุปภาพรวม (overallResult) ต้องสอดคล้องกับการให้คะแนนรายหมวด
- ให้เหตุผลสั้นๆ และข้อเสนอแนะเป็นรายการ bullet (array)

ให้พิจารณาผล precheck ที่ส่งให้ หากเห็นว่าเหมาะสมแล้ว สามารถยืนยันผลเดิมได้เลย แต่หากมีข้อสังเกตเพิ่มเติม ให้ปรับปรุงรายละเอียดให้เหมาะสม

ห้ามใช้คำตอบนอกเหนือจาก JSON schema ที่กำหนด`;

    const additional = additionalContext
      ? `บริบทเพิ่มเติมจากผู้ใช้:\n${additionalContext}`
      : '';

    const userPrompt = `${projectDetails}

${referenceDetails}

${precheckSummary}

${additional}

${instructions}`.trim();

    const responseSchema = {
      name: 'SmartApproveEvaluation',
      schema: {
        type: 'object',
        properties: {
          summary: {
            type: 'object',
            properties: {
              overallResult: {
                type: 'string',
                enum: ['ผ่าน', 'ควรปรับปรุง', 'ไม่ผ่าน'],
              },
              reason: { type: 'string' },
              suggestedActions: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['overallResult', 'reason', 'suggestedActions'],
          },
          categories: {
            type: 'object',
            properties: {
              strategy: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['ผ่าน', 'ควรปรับปรุง', 'ไม่ผ่าน'],
                  },
                  details: { type: 'string' },
                  suggestions: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['status', 'details', 'suggestions'],
              },
              projectInfo: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['ผ่าน', 'ควรปรับปรุง', 'ไม่ผ่าน'],
                  },
                  details: { type: 'string' },
                  suggestions: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['status', 'details', 'suggestions'],
              },
              location: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['ผ่าน', 'ควรปรับปรุง', 'ไม่ผ่าน'],
                  },
                  details: { type: 'string' },
                  suggestions: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['status', 'details', 'suggestions'],
              },
              budget: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['ผ่าน', 'ควรปรับปรุง', 'ไม่ผ่าน'],
                  },
                  details: { type: 'string' },
                  suggestions: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['status', 'details', 'suggestions'],
              },
              indicators: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['ผ่าน', 'ควรปรับปรุง', 'ไม่ผ่าน'],
                  },
                  details: { type: 'string' },
                  suggestions: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['status', 'details', 'suggestions'],
              },
            },
            required: [
              'strategy',
              'projectInfo',
              'location',
              'budget',
              'indicators',
            ],
          },
        },
        required: ['summary', 'categories'],
      },
    };

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: 'json_schema', json_schema: responseSchema },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      const content = completion.choices[0].message?.content;
      if (!content) {
        throw new InternalServerErrorException(
          'ไม่สามารถประมวลผลผลลัพธ์การประเมินโครงการได้',
        );
      }

      // Calculate and Log Usage
      if (completion.usage) {
        const costUsd = calculateAiCost('gpt-4o', completion.usage);
        await this.aiUsageQuotasService.checkAndLogUsage(userId, costUsd, {
          usageType: 'SMART_APPROVE_ANALYSIS',
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
        });
      }

      return JSON.parse(content);
    } catch (error) {
      // If it is an HttpException (like Quota exceeded), rethrow it
      if (error instanceof HttpException) {
        throw error;
      }
      console.error('Error calling OpenAI API for smart approve:', error);
      throw new InternalServerErrorException(
        'เกิดข้อผิดพลาดในการวิเคราะห์โครงการด้วย AI',
      );
    }
  }

  private mergePrecheckAndAi(
    precheck: SmartApproveEvaluationResponse,
    aiResult: SmartApproveEvaluationResponse,
  ): SmartApproveEvaluationResponse {
    const mergedCategories = Object.keys(precheck.categories).reduce(
      (acc, key) => {
        const categoryKey =
          key as keyof SmartApproveEvaluationResponse['categories'];
        const precheckCat = precheck.categories[categoryKey];
        const aiCat = aiResult.categories[categoryKey];

        // หมวด strategy และ location ใช้ผลจาก precheck เท่านั้น (ไม่ใช้ AI)
        if (categoryKey === 'strategy' || categoryKey === 'location') {
          acc[categoryKey] = precheckCat;
          return acc;
        }

        // หมวด projectInfo, budget, indicators ใช้ผลจาก AI โดยตรง (ไม่ merge กับ precheck)
        if (!aiCat) {
          acc[categoryKey] = precheckCat;
          return acc;
        }

        // ใช้ผลจาก AI โดยตรง
        acc[categoryKey] = {
          status: aiCat.status,
          details: aiCat.details,
          suggestions: aiCat.suggestions,
        };
        return acc;
      },
      {} as SmartApproveEvaluationResponse['categories'],
    );

    const summarySuggestions = new Set<string>([
      ...precheck.summary.suggestedActions,
      ...aiResult.summary.suggestedActions,
    ]);

    // คำนวณ overallResult ใหม่จาก categories ที่ merge แล้ว
    const statuses = Object.values(mergedCategories).map((c) => c.status);
    let overallResult: 'ผ่าน' | 'ควรปรับปรุง' | 'ไม่ผ่าน' = 'ผ่าน';
    if (statuses.includes('ไม่ผ่าน')) {
      overallResult = 'ไม่ผ่าน';
    } else if (statuses.includes('ควรปรับปรุง')) {
      overallResult = 'ควรปรับปรุง';
    }

    return {
      summary: {
        overallResult,
        reason: aiResult.summary.reason || precheck.summary.reason,
        suggestedActions: Array.from(summarySuggestions),
      },
      categories: mergedCategories,
    };
  }
}
