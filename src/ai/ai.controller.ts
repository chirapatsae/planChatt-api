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
import { GeoPreviewDto } from './dto/geo-preview.dto';
import { PreSubmitSnapshotService } from './pre-submit-snapshot.service';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { calculateAiCost } from './utils/cost-calculator';
// AI cooldown (CLAUDE.md §17.8). Per-endpoint TTLs per task IMPL_STAFF_AI_RF9_COOLDOWN.
import { AiCooldownGuard } from './guards/ai-cooldown.guard';
import { AiCooldown } from './decorators/ai-cooldown.decorator';
// Wave 29 N2 — briefing citations (opaque bag per Wave 13 DTO discipline).
import { parseCitationsJsonBlock } from './citation-parser';
// Wave 31 N1 — output sanitizer: strip bracketed section markers and
// substitute raw criterion IDs with Thai titles on LLM-authored prose
// before returning to FE. Pure text normalization; §17.2 advisory.
import { sanitizeBriefingText } from './briefing-sanitizer';
// Wave 34 N1 — LAO-type-aware budget floor. Controller-side defensive
// clamp (§17.9 deterministic-wins): even when the prompt clause told
// the LLM the floor, we re-clamp here. Agency / unknown org types
// produce a null floor and the envelope emits `budget: null`.
import {
  resolveBudgetFloor,
  parseBudgetString,
  clampBudget,
} from './budget/budget-rules';

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
    // Wave 33.6 N2 — feasibility verdict from FeasibilityGateService.
    // Top-level control-flow discriminator (deliberate exception to Wave 13
    // opaque DTO per CTO D5). Service may emit severity 'block' which
    // short-circuits the LLM call entirely; controller MUST omit
    // briefing/briefingRefs in that case to avoid sending stale or empty
    // payload alongside the block card. Pass/warn cases are unchanged.
    // §17.2 advisory — never gates workflow.
    const feasibility =
      (aiResponse as { feasibility?: unknown }).feasibility;
    const aiSkipped =
      (aiResponse as { aiSkipped?: unknown }).aiSkipped === true;
    // Wave 31 N1 sanitizer re-application (§17.9 defense-in-depth). Values
    // are service-authored Thai templates, but the Wave 31 sanitizer is
    // idempotent on marker-free input, so this pass is safe and belt-and-
    // braces. Structured fields (isFeasible, severity, triggeredRule) are
    // NOT sanitized — they are discriminators, not prose.
    const sanitizedFeasibility = (() => {
      if (!feasibility || typeof feasibility !== 'object') return feasibility;
      const f = feasibility as Record<string, unknown>;
      const patched: Record<string, unknown> = { ...f };
      if (typeof f.reason === 'string') {
        patched.reason = sanitizeBriefingText(f.reason);
      }
      if (Array.isArray(f.recommendations)) {
        patched.recommendations = f.recommendations.map((r) =>
          typeof r === 'string' ? sanitizeBriefingText(r) : r,
        );
      }
      return patched;
    })();
    // Wave 29 N1 — opaque briefingRefs bag (Wave 13 discipline). Only
    // populated when ISSUE_BASED geo lookup resolved a feature; omitted
    // entirely (not null) when unresolved. Advisory per §17.2 — never
    // gates workflow.
    const geoFeature = (aiResponse as { geoFeature?: unknown }).geoFeature;
    // Wave 30 N1 — deterministic conflict verdict from
    // `GeoConflictService`. NEVER trust LLM-generated `geoAnalysis`:
    // this value comes strictly from the service output in
    // `AiService.generateProjectDetail`. §17.9 re-assertion point.
    const geoAnalysis = (aiResponse as { geoAnalysis?: unknown }).geoAnalysis;
    // Wave 31 N2 — deterministic reverse-geocode triple (tambon /
    // amphoe / changwat). Service-authored Thai place names; NOT
    // sanitized (not LLM prose). Omitted from the envelope when null
    // per Wave 13 opaque-DTO discipline.
    const adminBoundary =
      (aiResponse as { adminBoundary?: unknown }).adminBoundary;
    // Wave 32 N2 — deterministic land-use pre-classifier verdict
    // sourced from `LandUseClassifierService` via
    // `AiService.generateProjectDetail` (NOT parsed from LLM prose).
    // §17.9 deterministic re-assertion: controller refuses to read
    // land-use data from `rawResult`; it only reads the service-authored
    // field on `aiResponse`. Opaque metadata bag per Wave 13 discipline
    // — omitted from the envelope when null.
    const landUseHint =
      (aiResponse as { landUseHint?: unknown }).landUseHint;

    // Wave 33.6 N2 — block short-circuit. When the feasibility gate fires
    // (service returned `aiSkipped: true` with `severity: 'block'`), the
    // LLM call was skipped entirely so `rawResult` is null. Emit ONLY the
    // feasibility envelope (per CTO D5) and OMIT briefing / briefingRefs /
    // content — the FE renders the block card instead of result cards.
    // §17.2 advisory: workflow actions remain available; this is UI-only.
    if (
      aiSkipped &&
      sanitizedFeasibility &&
      typeof sanitizedFeasibility === 'object' &&
      (sanitizedFeasibility as { severity?: unknown }).severity === 'block'
    ) {
      return {
        feasibility: sanitizedFeasibility,
        aiSkipped: true,
        usage: null,
        cost: 0,
      };
    }

    if (!rawResult) {
      return { message: 'AI failed to generate a result.' };
    }

    // Wave 29 N2 — parse + whitelist-filter citations from the LLM
    // output. §17.9 prompt-injection defense: sourceType whitelist is
    // enforced inside parseCitationsJsonBlock; malformed JSON returns
    // null and is silently dropped (no throw into request path).
    const parsedCitations = parseCitationsJsonBlock(rawResult);
    const hasCitations =
      Array.isArray(parsedCitations) && parsedCitations.length > 0;

    // Wave 31 N1 — sanitize LLM-authored `description` on each citation.
    // Structured metadata (`label`, `sourceType`, `sourceRef`) is left
    // untouched. Pure text normalization; no schema change.
    const sanitizedCitations = hasCitations
      ? (parsedCitations as NonNullable<typeof parsedCitations>).map((c) => {
          if (typeof c.description === 'string') {
            return { ...c, description: sanitizeBriefingText(c.description) };
          }
          return c;
        })
      : parsedCitations;

    // Wave 31 N1 — sanitize `reasons[]` / `recommendations[]` on the
    // deterministic `geoAnalysis` payload as a belt-and-braces pass.
    // The payload is service-authored (Wave 30 `GeoConflictService`) and
    // unlikely to carry markers, but the sanitizer is idempotent on
    // clean text; applying here protects against future regressions if
    // the payload ever blends in LLM-authored strings. Structured
    // fields (`conflictLevel`, `featureType`, `projectType`,
    // `rulesetVersion`) are NOT sanitized.
    const sanitizedGeoAnalysis = (() => {
      if (!geoAnalysis || typeof geoAnalysis !== 'object') return geoAnalysis;
      const g = geoAnalysis as Record<string, unknown>;
      const patched: Record<string, unknown> = { ...g };
      const reasons = g.reasons;
      if (Array.isArray(reasons)) {
        patched.reasons = reasons.map((r) =>
          typeof r === 'string' ? sanitizeBriefingText(r) : r,
        );
      }
      const recommendations = g.recommendations;
      if (Array.isArray(recommendations)) {
        patched.recommendations = recommendations.map((r) =>
          typeof r === 'string' ? sanitizeBriefingText(r) : r,
        );
      }
      return patched;
    })();

    // Presence-vs-absence on the envelope: omit the key entirely when
    // no usable citation data is available (FE uses absence as a
    // signal for progressive disclosure). Same discipline as
    // `geoFeature` in N1, `geoAnalysis` in Wave 30 N1, and
    // `adminBoundary` in Wave 31 N2.
    const briefingRefs =
      geoFeature ||
      hasCitations ||
      geoAnalysis ||
      adminBoundary ||
      landUseHint
        ? {
            ...(geoFeature ? { geoFeature } : {}),
            ...(adminBoundary ? { adminBoundary } : {}),
            ...(landUseHint ? { landUseHint } : {}),
            ...(hasCitations ? { citations: sanitizedCitations } : {}),
            ...(geoAnalysis ? { geoAnalysis: sanitizedGeoAnalysis } : {}),
          }
        : undefined;

    // Calculate cost
    const cost = usage ? calculateAiCost('gpt-4o', usage) : 0;

    const isIssueBased = body.reportFormat === 'ISSUE_BASED';

    // Wave 31 N1 — sanitize all long-form Thai prose fields. Sanitizer is
    // idempotent on marker-free / id-free input, so it is safe to apply on
    // BOTH STRATEGY_BASED and ISSUE_BASED paths without byte-drift.
    // `title` is deliberately NOT sanitized (short label; numeric project
    // names risk spurious pattern matches). Same reason applies to
    // `coordinateAreaLabel` below.
    const title = this.parseSection(rawResult, 'ชื่อโครงการ:');
    const objective = sanitizeBriefingText(
      this.parseSection(rawResult, 'วัตถุประสงค์:'),
    );
    const goal = sanitizeBriefingText(
      this.parseSection(rawResult, 'เป้าหมาย:'),
    );
    const expected = sanitizeBriefingText(
      this.parseSection(rawResult, 'ผลที่คาดว่าจะได้รับ:'),
    );
    // ISSUE_BASED: indicator is null per CLAUDE.md section 16.5
    const indicator = isIssueBased
      ? null
      : sanitizeBriefingText(this.parseSection(rawResult, 'ตัวชี้วัด:'));
    const existingContext = sanitizeBriefingText(
      this.parseSection(rawResult, 'ข้อมูลที่มี:'),
    );
    const projectRationale = sanitizeBriefingText(
      this.parseSection(rawResult, 'เหตุผลที่คิดโครงการนี้:'),
    );
    const locationSuitabilityBriefing = sanitizeBriefingText(
      this.parseSection(rawResult, 'ความเหมาะสมของพื้นที่:'),
    );
    const rawCoordinateAreaLabel = this.parseSection(
      rawResult,
      'ป้ายพื้นที่:',
    );

    // Wave 34 N1 — budget section. Parsed from LLM output and
    // defensively clamped to the LAO-type floor per §17.9
    // "deterministic wins over LLM" belt-and-braces principle. Null when:
    //   - generation omitted the section (agency / unknown type)
    //   - LLM output unparseable AND no floor to fall back to
    // When floor is present but LLM output unparseable, clampBudget
    // returns null (parsed is null) — FE still hides the card. The
    // floor-fallback case (parsed=null → return floor) is deliberately
    // NOT applied here per service contract in budget-rules.ts; the
    // missing-value signal (budget=null) is more faithful than a
    // fabricated floor. FE hides the budget card on null.
    const budgetFloor = resolveBudgetFloor(body.organizationType);
    const rawBudgetText = this.parseSection(rawResult, 'งบประมาณ:');
    const parsedBudget = parseBudgetString(rawBudgetText);
    const budget = clampBudget(parsedBudget, budgetFloor);

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
      // Wave 34 N1 — primary form field (CTO D5 exception to Wave 13
      // opaque DTO). `number | null`: null signals "no floor / no
      // output" and FE hides the budget card. Position after
      // `expected` and before `indicator` per envelope ordering spec.
      budget,
      indicator,
      existingContext,
      projectRationale,
      locationSuitabilityBriefing,
      coordinateAreaLabel,
      usage,
      cost,
      ...(briefingRefs ? { briefingRefs } : {}),
      // Wave 33.6 N2 — top-level `feasibility` for pass/warn cases
      // (deliberate exception to Wave 13 opaque DTO per CTO D5). STRATEGY_BASED
      // path has `feasibility === null` from N1, so the key is omitted and
      // the envelope stays byte-identical to pre-Wave-33.6.
      ...(sanitizedFeasibility ? { feasibility: sanitizedFeasibility } : {}),
    };
  }

  /**
   * Wave 35 N1 — lightweight geo preview.
   *
   * Returns the deterministic geo subset of the
   * `/generate-project-detail` envelope (geoFeature · adminBoundary ·
   * landUseHint · geoAnalysis · feasibility) WITHOUT invoking gpt-4o
   * prose generation and WITHOUT firing fresh gpt-4o-mini classifier
   * calls.
   *
   * Purpose: FE can render `GeoAnalysisCard` / `FeasibilityBlockCard` /
   * `AdminBoundaryChipRow` / `LandUseChipRow` IMMEDIATELY on pin +
   * sub-type selection without waiting ~10s for the main
   * `/generate-project-detail` round-trip.
   *
   * Constraints:
   *   - §17.2 advisory — read-only, no workflow gating
   *   - §17.3 audit separation — no DB writes, no FK, no
   *     `tracking_status` row creation
   *   - §17.5 no auto-recompute — classifier is cache-hit-only
   *     (`peekCache`), NEVER `classify`
   *   - §17.8 cooldown N/A — endpoint produces no LLM output, so
   *     `AiCooldownGuard` is deliberately NOT applied
   *   - §17.9 injection-safe — DTO accepts no user prose at all
   *   - §17.11 no role exemption (JwtAuthGuard only)
   *
   * Agency / non-ISSUE_BASED callers: the service short-circuits to
   * a minimal envelope with `feasibility: { isFeasible: true,
   * severity: 'pass' }` and all other fields null. This mirrors the
   * ISSUE_BASED-only gate used by `/generate-project-detail`.
   */
  @Post('geo-preview')
  async geoPreview(
    @Body() body: GeoPreviewDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.aiService.buildGeoPreview({
      lat: body.lat,
      lng: body.lng,
      subTypeCode: body.subTypeCode,
      reportFormat: body.reportFormat,
    });
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
    // Wave 31 hotfix follow-up: sanitize regenerated field output through
    // the same pipeline as the main `generate-project-detail` endpoint so
    // bracketed markers, raw criterion IDs, and sub-type codes never leak
    // on single-field regeneration either. `title` is short enough that
    // sanitizer is safe-idempotent; applying to all fields uniformly.
    const sanitizedContent = sanitizeBriefingText(newContent);
    return { newContent: sanitizedContent, usage, cost };
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