import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AiService } from './ai.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import {
  GenerateProjectDto,
  RegenerateFieldDto,
} from './dto/generate-project.dto';
import { PromptSuggestionsDto } from './dto/prompt-suggestions.dto';
import { SmartApproveRequestDto } from './dto/smart-approve.dto';
import { PreSubmitReviewDto } from './dto/pre-submit-review.dto';
import { CreatePreSubmitSnapshotDto } from './dto/pre-submit-snapshot.dto';
import { PreSubmitSnapshotService } from './pre-submit-snapshot.service';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { calculateAiCost } from './utils/cost-calculator';
// AI cooldown (CLAUDE.md §17.8). Per-endpoint TTLs per task IMPL_STAFF_AI_RF9_COOLDOWN.
import { AiCooldownGuard } from './guards/ai-cooldown.guard';
import { AiCooldown } from './decorators/ai-cooldown.decorator';

@Controller({
  version: '1',
  path: 'ai',
})
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly preSubmitSnapshotService: PreSubmitSnapshotService,
  ) { }

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
    const aiResponse = await this.aiService.generateProjectDetail(body, userId);

    if (!aiResponse) {
      return { message: 'AI failed to generate a result.' };
    }

    const { content: rawResult, usage } = aiResponse;

    if (!rawResult) {
      return { message: 'AI failed to generate a result.' };
    }

    // Calculate cost
    const cost = usage ? calculateAiCost('gpt-4o', usage) : 0;

    const isIssueBased = body.reportFormat === 'ISSUE_BASED';

    const title = this.parseSection(rawResult, 'ชื่อโครงการ:');
    const objective = this.parseSection(rawResult, 'วัตถุประสงค์:');
    const goal = this.parseSection(rawResult, 'เป้าหมาย:');
    const expected = this.parseSection(rawResult, 'ผลที่คาดว่าจะได้รับ:');
    // ISSUE_BASED: indicator is null per CLAUDE.md section 16.5
    const indicator = isIssueBased
      ? null
      : this.parseSection(rawResult, 'ตัวชี้วัด:');
    const existingContext = this.parseSection(rawResult, 'ข้อมูลที่มี:');
    const projectRationale = this.parseSection(
      rawResult,
      'เหตุผลที่คิดโครงการนี้:',
    );
    const locationSuitabilityBriefing = this.parseSection(
      rawResult,
      'ความเหมาะสมของพื้นที่:',
    );
    const rawCoordinateAreaLabel = this.parseSection(
      rawResult,
      'ป้ายพื้นที่:',
    );

    // Normalize label: trim to 32 chars, strip trailing punctuation,
    // coerce empty to null.
    let coordinateAreaLabel: string | null = null;
    if (rawCoordinateAreaLabel) {
      const cleaned = rawCoordinateAreaLabel
        .trim()
        .replace(/[\s\u00A0]+/g, ' ')
        .replace(/[\.,;:!\?\-–—"'`“”‘’()[\]{}]+$/u, '')
        .trim()
        .slice(0, 32);
      coordinateAreaLabel = cleaned.length > 0 ? cleaned : null;
    }

    return {
      title,
      objective,
      goal,
      expected,
      indicator,
      existingContext,
      projectRationale,
      locationSuitabilityBriefing,
      coordinateAreaLabel,
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
  @UseGuards(AiCooldownGuard)
  @AiCooldown('smart-approve', 10, 'body.projectId')
  async analyzeSmartApprove(
    @Body() body: SmartApproveRequestDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.aiService.analyzeProjectForSmartApprove(body, req.user.userId);
  }

  /**
   * Holistic pre-submit quality review (owner-facing).
   *
   * Returns: overallScore (0–100), readinessLabel, rationale, strongPoint,
   * suggestions (prioritised), checklistSummary (procedural checks).
   *
   * CLAUDE.md §13: advisory only — does NOT block submission.
   * CLAUDE.md §16.5: ISSUE_BASED payloads must not send indicator.
   */
  @Post('pre-submit-review')
  async preSubmitReview(
    @Body() body: PreSubmitReviewDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.aiService.generatePreSubmitReview(body, req.user.userId);
  }

  /**
   * RF5 — Persist user-side pre-submit AI score for staff read.
   *
   * CLAUDE.md §17.3 — the row has NO FK to project tables; `target_id` is a
   * plain uuid column so staff-led rollback (§14.6) cannot cascade-delete
   * AI audit history.
   *
   * CLAUDE.md §17.4 — `staleness_policy = 'snapshot-only'`: the snapshot is
   * a photograph at submit time. It is intentionally NEVER recomputed and
   * `isStale` is ALWAYS false on the read side.
   *
   * Guard: JwtAuthGuard (controller-level). Owner-scope is enforced in the
   * service against the caller's current WorkHistory.id (§4 ownership).
   *
   * Idempotency: identical content_hash returns the existing row without
   * inserting a new one. Different hash soft-deletes the prior row and
   * inserts a new one (§17.5 audit preservation).
   */
  @Post('pre-submit-review/snapshot')
  async createPreSubmitSnapshot(
    @Body() body: CreatePreSubmitSnapshotDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    const snapshot = await this.preSubmitSnapshotService.createSnapshot(
      req.user.userId,
      body,
    );
    return {
      id: snapshot.id,
      targetKind: snapshot.targetKind,
      targetId: snapshot.targetId,
      computedAt: snapshot.computedAt,
      contentHash: snapshot.contentHash,
      score: snapshot.score0100,
      band: snapshot.band,
    };
  }

  /**
   * RF5 — Staff-lead read for the active pre-submit snapshot.
   *
   * §17.4: response envelope always has `isStale: false` (snapshot-only).
   * 404 when no active snapshot exists — FE renders subdued fallback
   * "ไม่มีข้อมูลการตรวจก่อนส่ง".
   */
  @Get('pre-submit-review/snapshot/:targetKind/:targetId')
  async getPreSubmitSnapshot(
    @Param('targetKind') targetKind: string,
    @Param('targetId', new ParseUUIDPipe()) targetId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    const { snapshot, envelope, result } =
      await this.preSubmitSnapshotService.getActiveSnapshot(
        req.user.userId,
        targetKind,
        targetId,
      );
    return {
      envelope,
      result,
      workflow: snapshot.workflow,
      submittedAt: snapshot.computedAt,
    };
  }

  /**
   * RF5 — Owner-gated read of the caller's OWN pre-submit AI snapshot.
   *
   * Unlike `pre-submit-review/snapshot/:...` (staff-lead read), this
   * endpoint is scoped to the current user's WorkHistory. The service
   * method `getOwnerSnapshot` enforces
   * `submitted_by_work_history_id === caller.currentWorkHistory.id` and
   * returns 403 on mismatch, 404 on missing.
   *
   * Designed for the ReadyToSendPage AI modal to reuse the canonical
   * AddProject-time snapshot and save OpenAI tokens (§17.2 advisory —
   * cache-reuse is a read, not a recompute).
   *
   * §17.3 audit separation preserved — read-only, no writes, no FK.
   * §17.4 snapshot-only — envelope's `isStale` forced to false.
   * §17.5 no auto-recompute — pure read, no mutations.
   * §17.11 no role exemption — owner gate is a sibling to the
   *   staff-lead gate, not an override of either.
   */
  @Get('pre-submit-review/my-snapshot/:targetKind/:targetId')
  async getMyPreSubmitSnapshot(
    @Param('targetKind') targetKind: string,
    @Param('targetId', new ParseUUIDPipe()) targetId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    const { snapshot, envelope, result } =
      await this.preSubmitSnapshotService.getOwnerSnapshot(
        req.user.userId,
        targetKind,
        targetId,
      );
    return {
      envelope,
      result,
      workflow: snapshot.workflow,
      submittedAt: snapshot.computedAt,
    };
  }

  /**
   * Return 4-6 short Thai imperative prompt hints for the AI composer.
   *
   * Failure semantics: on any LLM error or empty parse result the service
   * returns { suggestions: [] } with HTTP 200 — the frontend then falls
   * back to its local pool. We deliberately do NOT surface 5xx here.
   *
   * §16.5: ISSUE_BASED suggestions never mention ตัวชี้วัด / KPI.
   */
  @Post('prompt-suggestions')
  async promptSuggestions(
    @Body() body: PromptSuggestionsDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    const { suggestions } = await this.aiService.generatePromptSuggestions(body);
    return { suggestions };
  }
}