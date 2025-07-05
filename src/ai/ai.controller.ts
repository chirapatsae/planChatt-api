// src/ai/ai.controller.ts
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { GenerateProjectDto, RegenerateFieldDto } from './dto/generate-project.dto';

@Controller({
  version: '1',
  path: 'ai',
})
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /**
   * [Final Version] ฟังก์ชันสำหรับแยกข้อมูลและทำความสะอาดผลลัพธ์
   * รองรับ Markdown (ตัวหนา **) และลบอักขระที่ไม่ต้องการออก
   * @param text ข้อความทั้งหมดจาก AI
   * @param keyword Keyword ที่ต้องการค้นหา เช่น "ชื่อโครงการ:"
   * @returns ข้อความที่สะอาดแล้ว หรือ null ถ้าไม่เจอ
   */
  private parseSection(text: string, keyword: string): string | null {
    const keyText = keyword.replace(':', '');
    const regex = new RegExp(`(?:\\*\\*)?${keyText}(?:\\*\\*)?\\s*:([^]*?)(?=\\n\\s*\\*\\*|$)`, 's');
    const match = text.match(regex);

    if (match && match[1]) {
      const rawContent = match[1];

      // ขั้นตอนการทำความสะอาดข้อมูลเพื่อลบ ** และช่องว่างที่ไม่ต้องการออก
      const cleanedContent = rawContent.trim().replace(/^\s*\*{1,2}\s*/, '').trim();
      
      return cleanedContent;
    }
    
    return null;
  }

  @Post('generate-project-detail')
  async generate(@Body() body: GenerateProjectDto) {
    const rawResult = await this.aiService.generateProjectDetail(
      body.strategy,
      body.tactic,
      body.plan,
      body.userPrompt,
    );

    if (!rawResult) {
      return { message: 'AI failed to generate a result.' };
    }

    // ส่วนนี้จะทำงานได้ถูกต้องด้วยฟังก์ชัน parseSection เวอร์ชันล่าสุด
    const title = this.parseSection(rawResult, 'ชื่อโครงการ:');
    const objective = this.parseSection(rawResult, 'วัตถุประสงค์:');
    const goal = this.parseSection(rawResult, 'เป้าหมาย:');
    const expected = this.parseSection(rawResult, 'ผลที่คาดว่าจะได้รับ:');
    const indicator = this.parseSection(rawResult, 'ตัวชี้วัด:');

    return {
      title,
      objective,
      goal,
      expected,
      indicator,
    //   rawResult,
    };
  }

  // ✨ --- Endpoint ใหม่สำหรับ Regenerate --- ✨
  @Post('regenerate-one-field')
  async regenerateField(@Body() body: RegenerateFieldDto) {
    // 2. เรียกใช้ Service ใหม่ที่สร้างขึ้น
    const newContent = await this.aiService.regenerateField(body);

    // 3. คืนค่าเป็น newContent ตามที่ Frontend คาดหวัง
    return { newContent };
  }

  
}