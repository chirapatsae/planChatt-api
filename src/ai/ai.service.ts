import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { OpenAI } from 'openai';
import { RegenerateFieldDto } from './dto/generate-project.dto';

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateProjectDetail(
    strategy: string,
    tactic: string,
    plan: string,
    userPrompt?: string,
  ) {
    const systemPrompt = `คุณเป็นเจ้าหน้าที่วางแผนพัฒนาท้องถิ่นผู้เชี่ยวชาญ มีหน้าที่ให้คำแนะนำและร่างรายละเอียดโครงการโดยใช้ภาษาราชการไทยที่ถูกต้องและสละสลวย`;
    let mainPrompt = `จากแผนงาน "${plan}", ยุทธศาสตร์ "${strategy}", และกลยุทธ์ "${tactic}" โปรดช่วยเสนอ "ชื่อโครงการ", "วัตถุประสงค์", "เป้าหมาย", "ผลที่คาดว่าจะได้รับ", และ "ตัวชี้วัด"`;

    if (userPrompt?.trim()) {
      mainPrompt += `\n\nโดยมีรายละเอียดหรือเงื่อนไขเพิ่มเติมที่ต้องพิจารณาเป็นพิเศษ ดังนี้:\n"${userPrompt}"`;
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.5,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: mainPrompt },
        ],
      });

      return completion.choices[0].message.content;
    } catch (error) {
      console.error('Error calling OpenAI API:', error);
      throw new InternalServerErrorException(
        'เกิดข้อผิดพลาดในการประมวลผลข้อมูลกับ AI',
      );
    }
  }

  async regenerateField(dto: RegenerateFieldDto): Promise<string> {
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

      if (completion.choices[0].message?.content) {
        return completion.choices[0].message.content.trim();
      }
      throw new InternalServerErrorException(
        'AI response is invalid or incomplete.',
      );
    } catch (error) {
      console.error('Error calling OpenAI API for regeneration:', error);
      throw new InternalServerErrorException(
        'เกิดข้อผิดพลาดในการสร้างข้อมูลใหม่จาก AI',
      );
    }
  }
}
