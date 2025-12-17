// src/ai/ai.controller.ts
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import {
  GenerateProjectDto,
  RegenerateFieldDto,
} from './dto/generate-project.dto';
import { SmartApproveRequestDto } from './dto/smart-approve.dto';

@Controller({
  version: '1',
  path: 'ai',
})
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  private parseSection(text: string, keyword: string): string | null {
    const keyText = keyword.replace(':', '');
    // รองรับทั้ง format **ชื่อโครงการ:** และ ชื่อโครงการ:
    const regex = new RegExp(
      `(?:\\*\\*)?${keyText}(?:\\*\\*)?\\s*:([^]*?)(?=\\n\\s*\\*\\*|$)`,
      's',
    );
    const match = text.match(regex);

    if (match && match[1]) {
      const rawContent = match[1];
      const cleanedContent = rawContent
        .trim()
        .replace(/^\s*\*{1,2}\s*/, '')
        .trim();
      return cleanedContent;
    }

    // Fallback: ลองหาแบบไม่มี **
    const fallbackRegex = new RegExp(
      `${keyText}\\s*:([^]*?)(?=\\n\\s*[^\\n]*:|$)`,
      's',
    );
    const fallbackMatch = text.match(fallbackRegex);
    
    if (fallbackMatch && fallbackMatch[1]) {
      return fallbackMatch[1].trim();
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

    // Debug: Log the raw result
    console.log('Raw AI Result:', rawResult);

    const title = this.parseSection(rawResult, 'ชื่อโครงการ:');
    const objective = this.parseSection(rawResult, 'วัตถุประสงค์:');
    const goal = this.parseSection(rawResult, 'เป้าหมาย:');
    const expected = this.parseSection(rawResult, 'ผลที่คาดว่าจะได้รับ:');
    const indicator = this.parseSection(rawResult, 'ตัวชี้วัด:');

    // Debug: Log parsed results
    console.log('Parsed Results:', { title, objective, goal, expected, indicator });

    return {
      title,
      objective,
      goal,
      expected,
      indicator,
    };
  }

  @Post('regenerate-one-field')
  async regenerateField(@Body() body: RegenerateFieldDto) {
    const newContent = await this.aiService.regenerateField(body);
    return { newContent };
  }

  @Post('smart-approve/analyze')
  async analyzeSmartApprove(@Body() body: SmartApproveRequestDto) {
    return this.aiService.analyzeProjectForSmartApprove(body);
  }

}