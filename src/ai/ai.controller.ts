import { Controller, Post, Body, UseGuards, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AiService } from './ai.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import {
  GenerateProjectDto,
  RegenerateFieldDto,
} from './dto/generate-project.dto';
import { SmartApproveRequestDto } from './dto/smart-approve.dto';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { calculateAiCost } from './utils/cost-calculator';

@Controller({
  version: '1',
  path: 'ai',
})
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) { }

  private parseSection(text: string, keyword: string): string | null {
    const keyText = keyword.replace(':', '');

    // Regex to match **Keyword:** or Keyword:
    // Matches optional **, keyword, optional **, colon, and captures content until next ** section or end of string
    const pattern = `(?:\\*\\*)?${keyText}(?:\\*\\*)?\\s*:([^]*?)(?=\\n\\s*\\*\\*|$)`;

    // Fallback: match without ** lookahead if the first one fails or for simpler format
    // Matches keyword, colon, and captures content until next newline followed by something ending in colon (next section header)
    const fallbackPattern = `${keyText}\\s*:([^]*?)(?=\\n\\s*[^\\n]*:|$)`;

    let match = text.match(new RegExp(pattern, 's'));

    if (!match || !match[1]) {
      match = text.match(new RegExp(fallbackPattern, 's'));
    }

    if (match && match[1]) {
      const rawContent = match[1];
      return rawContent
        .trim()
        .replace(/^\s*\*{1,2}\s*/, '') // Remove leading ** if captured
        .trim();
    }

    return null;
  }

  @Post('generate-project-detail')
  async generate(@Body() body: GenerateProjectDto, @Req() req: Request & { user: JwtPayloadUser }) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    const userId = req.user.userId;
    const aiResponse = await this.aiService.generateProjectDetail(
      body.strategy,
      body.tactic,
      body.plan,
      userId,
      body.userPrompt,
    );

    if (!aiResponse) {
      return { message: 'AI failed to generate a result.' };
    }

    const { content: rawResult, usage } = aiResponse;

    if (!rawResult) {
      return { message: 'AI failed to generate a result.' };
    }

    // Debug: Log the raw result
    console.log('Raw AI Result:', rawResult);

    // Calculate cost
    const cost = usage ? calculateAiCost('gpt-4o', usage) : 0;

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
      usage,
      cost,
    };
  }

  @Post('regenerate-one-field')
  async regenerateField(@Body() body: RegenerateFieldDto, @Req() req: Request & { user: JwtPayloadUser }) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    const userId = req.user.userId;
    const { content: newContent, usage } = await this.aiService.regenerateField(
      body,
      userId,
    );
    const cost = usage ? calculateAiCost('gpt-4o', usage) : 0;
    return { newContent, usage, cost };
  }

  @Post('smart-approve/analyze')
  async analyzeSmartApprove(
    @Body() body: SmartApproveRequestDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.aiService.analyzeProjectForSmartApprove(body, req.user.userId);
  }
}