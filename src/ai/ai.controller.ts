// src/ai/ai.controller.ts
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import {
  GenerateProjectDto,
  RegenerateFieldDto,
} from './dto/generate-project.dto';

@Controller({
  version: '1',
  path: 'ai',
})
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  private parseSection(text: string, keyword: string): string | null {
    const keyText = keyword.replace(':', '');
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
    };
  }

  @Post('regenerate-one-field')
  async regenerateField(@Body() body: RegenerateFieldDto) {
    const newContent = await this.aiService.regenerateField(body);
    return { newContent };
  }
}
