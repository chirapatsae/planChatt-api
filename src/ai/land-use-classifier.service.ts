/**
 * LandUseClassifierService — Wave 32 N1
 *
 * Cheap pre-classification LLM call that resolves the land-use
 * character of a pin's tambon (urban / agricultural / peri-urban /
 * industrial / natural-protected / ...) and exposes a structured
 * verdict to `AiService`. N2 consumes the verdict for prompt-side
 * injection; this node ONLY provides the service and wires it into
 * the caller's payload.
 *
 * Gated to ISSUE_BASED at the call site. STRATEGY_BASED path MUST
 * remain byte-identical.
 *
 * CLAUDE.md compliance:
 *   - §17.2 advisory-only — the verdict MUST NEVER gate workflow
 *   - §17.3 audit separation — no DB persistence, no FK, no
 *     `tracking_status` writes. In-memory LRU+TTL cache only.
 *   - §17.4 not a snapshot — no `content_hash` contract; TTL-based
 *     invalidation only (no auto-recompute).
 *   - §17.5 no auto-recompute — TTL expiry simply forces a fresh
 *     call on the NEXT classify() invocation.
 *   - §17.9 injection defense — classifier receives ONLY structured
 *     fields (admin-boundary names, geoFeature enum, subTypeCode
 *     enum, numeric lat/lng). NO user-controlled prose ever reaches
 *     this prompt. Output is schema-validated strictly; any drift
 *     returns null (fail-open).
 *   - §17.11 no role exemption.
 *
 * Error discipline: every failure path (network, timeout, 5xx,
 * malformed JSON, schema drift) returns `null` and caches the null
 * with a short TTL so transient failures retry sooner than stable
 * low-confidence classifications. MUST NEVER throw into the request
 * path — the caller's `isIssueBased && adminBoundary` gate guarantees
 * we reach here only on the advisory path.
 */
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
// PRIV-W44-01 — central LLM abstraction (CLAUDE.md §17).
import { LLM_CLIENT, LlmClient } from './llm/llm-client.interface';
import { sanitizeBriefingText } from './briefing-sanitizer';
// Wave 36 N2 — resolve the Wave 32 circular-dep TODO. `AiUsageLogsService`
// is pulled in via forwardRef so classifier runs under the shared
// detail-log contract. §17.3 audit separation: bare uuid `targetId`,
// no FK into project tables; log failure is best-effort and must
// never throw into the classifier's fail-open path.
import { AiUsageLogsService } from 'src/ai-usage-logs/ai-usage-logs.service';
import { composeSummaryTh } from 'src/ai-usage-logs/summary-th.util';
import { sanitizeRequestPayload } from 'src/ai-usage-logs/sanitize-request-payload.util';
import { calculateAiCost } from './utils/cost-calculator';
// SEC-W44-02 — INPUT-side PII redactor (§17.9).  The classifier input
// is structural (admin-boundary names, enum subTypeCode, numeric
// lat/lng) and contains no user prose by design, so redaction is
// effectively a no-op; the uniform retrofit keeps the grep gate
// stable against future prompt shape changes.
import { PiiRedactorService } from 'src/common/pii/pii-redactor.service';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PrimaryUse =
  | 'urban-dense'
  | 'urban-sparse'
  | 'peri-urban'
  | 'rural-village'
  | 'agricultural'
  | 'industrial'
  | 'natural-protected'
  | 'water-body-adjacent'
  | 'transportation-corridor'
  | 'mixed'
  | 'unknown';

export type Confidence = 'high' | 'medium' | 'low';

export interface LandUseClassification {
  primaryUse: PrimaryUse;
  secondaryUse?: string; // free-form Thai, optional, sanitized, <=120 chars
  confidence: Confidence;
  rationale: string; // 1-2 Thai sentences, sanitized, <=400 chars
  landmarks?: string[]; // optional Thai strings, each sanitized, max 5 x 80
}

/**
 * Structured-only input contract. Narrowly typed on purpose:
 * user-controlled prose MUST NOT flow through this surface (§17.9).
 */
export interface ClassifyInput {
  lat: number;
  lng: number;
  adminBoundary: {
    tambonCode: string;
    tambonName: string;
    amphoeCode: string;
    amphoeName: string;
    changwatCode: string;
    changwatName: string;
  };
  geoFeature?: {
    featureType: 'reservoir' | 'river' | 'canal';
    nameTh: string;
  } | null;
  /**
   * Sub-type code from the Wave 24 criterion registry (e.g. '4.1').
   * Structured enum, NOT user prose — safe to include.
   */
  subTypeCode?: string;
  /**
   * Wave 36 N2 — optional quota binding for `ai_usage_logs` detail
   * rows. Resolved by the CALLER (e.g. `AiService`) via
   * `AiUsageQuotasService.findQuotaIdByUserId(userId)` and threaded
   * through ClassifyInput so classifier stays decoupled from the
   * quota module. When omitted the log row is written without a
   * quota binding (rare — ops-only cost tracking).
   */
  aiUsageQuotaId?: string;
  /**
   * Wave 36 N2 — optional acting work-history id for audit context.
   * Bare uuid per §17.3 (no FK into `work_histories`).
   */
  actorWorkHistoryId?: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const PRIMARY_USE_VALUES: ReadonlySet<PrimaryUse> = new Set<PrimaryUse>([
  'urban-dense',
  'urban-sparse',
  'peri-urban',
  'rural-village',
  'agricultural',
  'industrial',
  'natural-protected',
  'water-body-adjacent',
  'transportation-corridor',
  'mixed',
  'unknown',
]);

const CONFIDENCE_VALUES: ReadonlySet<Confidence> = new Set<Confidence>([
  'high',
  'medium',
  'low',
]);

const MAX_RATIONALE_LEN = 400;
const MAX_SECONDARY_LEN = 120;
const MAX_LANDMARK_COUNT = 5;
const MAX_LANDMARK_LEN = 80;

// Anti-bias clause — verbatim acceptance string grepped by the spec.
const ANTI_BIAS_CLAUSE_TH =
  'ห้ามจับคู่ผลการจำแนกให้สอดคล้องกับหัวข้อโครงการที่ผู้ใช้ระบุ (classify honestly; do not match verdict to project\'s topic)';

const SYSTEM_PROMPT = [
  'คุณเป็นผู้เชี่ยวชาญการวิเคราะห์การใช้ประโยชน์ที่ดินในจังหวัดนครราชสีมา',
  '',
  'งานของคุณ: จำแนกประเภทการใช้ประโยชน์ที่ดินของพิกัดที่ระบุ โดยอิงจากข้อมูลตำบล/อำเภอ/จังหวัด และข้อมูลลักษณะพื้นที่ที่มีให้',
  '',
  `**สำคัญมาก — ความเป็นกลาง**: ต้องจำแนกอย่างตรงไปตรงมา ${ANTI_BIAS_CLAUSE_TH}`,
  '',
  '**สำคัญ — ลำดับความสำคัญพิกัดจริง**: หากพิกัดที่ระบุอยู่บนแหล่งน้ำ (อ่างเก็บน้ำ · ทะเลสาบ · แม่น้ำ · คลอง) ให้จำแนกเป็น "water-body-adjacent" โดยเน้นลักษณะพิกัดจริง ไม่ใช่ลักษณะตำบลโดยรวม — แม้ตำบลนั้นจะมีลักษณะชนบทหรือเกษตรกรรมเป็นส่วนใหญ่ ก็ห้ามใช้บริบทตำบลมาเปลี่ยนผลการจำแนก',
  '',
  '**รูปแบบผลลัพธ์** — ต้องตอบเป็น JSON เท่านั้น ตามสกีมา:',
  '{',
  '  "primaryUse": "urban-dense|urban-sparse|peri-urban|rural-village|agricultural|industrial|natural-protected|water-body-adjacent|transportation-corridor|mixed|unknown",',
  '  "secondaryUse": "<optional — คำอธิบายประเภทรองเป็นภาษาไทย>",',
  '  "confidence": "high|medium|low",',
  '  "rationale": "<1-2 ประโยคภาษาไทยอธิบายเหตุผลการจำแนก>",',
  '  "landmarks": ["<optional — สถานที่สำคัญใกล้เคียง>", "..."]',
  '}',
  '',
  '**กฎการประเมินความเชื่อมั่น (confidence)**:',
  '- high — ตำบลนี้มีลักษณะเฉพาะที่ชัดเจน (เช่น พื้นที่ใจกลางเมือง · เขตอุตสาหกรรมที่รู้จัก · พื้นที่ป่าสงวน)',
  '- medium — มีข้อมูลบ่งชี้แต่ไม่ชัดเจน 100%',
  '- low — ไม่มีข้อมูลเพียงพอในการจำแนก — ในกรณีนี้ให้ใช้ primaryUse = "unknown"',
  '',
  'ห้ามแต่งข้อมูลสถานที่สำคัญหากไม่ทราบจริง — เว้น landmarks เป็น array ว่างหรือไม่ส่งคีย์',
].join('\n');

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: LandUseClassification | null;
  expiresAt: number;
}

@Injectable()
export class LandUseClassifierService {
  private readonly logger = new Logger(LandUseClassifierService.name);

  // FIFO cache via Map insertion order. Adequate per task spec —
  // not a full LRU, but §17.5-compliant: TTL expiry plus bounded
  // size prevents unbounded memory.
  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_MAX = 1000;
  // Success TTL: 24h. Classifications for stable admin boundaries
  // do not shift within a day.
  private readonly SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
  // Failure TTL: 1h. Short so transient upstream hiccups retry
  // sooner than a solidly-unknown tambon.
  private readonly FAILURE_TTL_MS = 60 * 60 * 1000;

  constructor(
    // Wave 36 N2 — resolves the Wave 32 TODO. forwardRef defuses the
    // theoretical `ai.module ↔ ai-usage-logs.module` cycle (one-sided
    // today because AiUsageLogsModule is a leaf).
    @Inject(forwardRef(() => AiUsageLogsService))
    private readonly aiUsageLogsService: AiUsageLogsService,
    // PRIV-W44-01 — central LLM client.
    @Inject(LLM_CLIENT)
    private readonly llm: LlmClient,
    // SEC-W44-02 — INPUT-side PII redactor.  No-op on classifier's
    // structured input by design; retrofit kept uniform to satisfy
    // §17.9 grep gate and guard against future prompt drift.
    private readonly piiRedactor: PiiRedactorService,
  ) {}

  /**
   * Classify the land-use character of a pin inside NR.
   *
   * Returns `null` on:
   *   - OpenAI network / 5xx / timeout / auth failure
   *   - Malformed JSON response
   *   - Schema validation failure (primaryUse/confidence drift,
   *     missing rationale, over-long fields, too many landmarks)
   *
   * Never throws — caller treats `null` as "no hint available".
   */
  async classify(input: ClassifyInput): Promise<LandUseClassification | null> {
    const cacheKey = `${input.adminBoundary.amphoeCode}:${input.adminBoundary.tambonCode}`;

    // ---- cache lookup --------------------------------------------------
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached && cached.expiresAt <= now) {
      this.cache.delete(cacheKey);
    }

    // ---- build prompts (structured input only; NO user prose) -----------
    const userPrompt = this.buildUserPrompt(input);

    // SEC-W44-02 — §17.9 PII redactor invocation.  Intentionally a no-op
    // for the classifier (input is structural; see class comment) but
    // kept in-function to satisfy the grep-gate "every LLM call site
    // has upstream redaction" invariant, and to catch any future input
    // shape change that introduces user prose.
    const { output: redactedClassifierPrompt } = this.piiRedactor.redactText(
      userPrompt,
      { endpoint: 'land-use-classify' },
    );

    // ---- OpenAI call ---------------------------------------------------
    let raw: string | null | undefined;
    const startTime = Date.now();
    try {
      const completion = await this.llm.createChatCompletion({
        model: 'gpt-4o-mini',
        temperature: 0.15,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: redactedClassifierPrompt },
        ],
      });
      raw = completion.choices?.[0]?.message?.content;
      if (completion.usage) {
        this.logger.log(
          `[LandUseClassifier] openai usage promptTokens=${completion.usage.prompt_tokens} completionTokens=${completion.usage.completion_tokens} model=gpt-4o-mini`,
        );
      }
      // Wave 36 N2 — rich-detail usage log. Resolves the Wave 32 TODO.
      // §17.2 advisory: failure is swallowed so classifier stays
      // fail-open. §17.3: `targetId` is a bare uuid (or undefined —
      // classifier has no project row).
      try {
        const costUsd = completion.usage
          ? calculateAiCost('gpt-4o-mini', completion.usage)
          : 0;
        const durationMs = Date.now() - startTime;
        await this.aiUsageLogsService.create({
          usageType: 'LAND_USE_CLASSIFY',
          modelName: 'gpt-4o-mini',
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
          inputTextLength: SYSTEM_PROMPT.length + userPrompt.length,
          outputTextLength: typeof raw === 'string' ? raw.length : 0,
          costBaht: costUsd * 34,
          aiUsageQuotaId: input.aiUsageQuotaId,
          endpoint: 'land-use-classify',
          summaryTh: composeSummaryTh({
            endpoint: 'land-use-classify',
            tambonName: input.adminBoundary.tambonName,
            amphoeName: input.adminBoundary.amphoeName,
          }),
          requestPayload: sanitizeRequestPayload({
            lat: input.lat,
            lng: input.lng,
            adminBoundary: input.adminBoundary,
            geoFeature: input.geoFeature ?? null,
            subTypeCode: input.subTypeCode,
          }),
          responsePayload: {
            rawLength: typeof raw === 'string' ? raw.length : 0,
          },
          targetKind: 'none',
          actorWorkHistoryId: input.actorWorkHistoryId,
          durationMs,
        });
      } catch (logErr) {
        this.logger.warn(
          `[LandUseClassifier] ai-usage-log write failed (swallowed): ${logErr instanceof Error ? logErr.message : logErr}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[LandUseClassifier] openai call failed (fail-open): ${err instanceof Error ? err.message : err}`,
      );
      // Wave 36 N2 — error-path log so failures are visible in the
      // detail view too. Same fail-open discipline applies.
      try {
        const durationMs = Date.now() - startTime;
        await this.aiUsageLogsService.create({
          usageType: 'LAND_USE_CLASSIFY',
          modelName: 'gpt-4o-mini',
          inputTokens: 0,
          outputTokens: 0,
          inputTextLength: SYSTEM_PROMPT.length + userPrompt.length,
          outputTextLength: 0,
          costBaht: 0,
          aiUsageQuotaId: input.aiUsageQuotaId,
          endpoint: 'land-use-classify',
          summaryTh: composeSummaryTh({
            endpoint: 'land-use-classify',
            tambonName: input.adminBoundary.tambonName,
            amphoeName: input.adminBoundary.amphoeName,
          }),
          requestPayload: sanitizeRequestPayload({
            lat: input.lat,
            lng: input.lng,
            adminBoundary: input.adminBoundary,
            geoFeature: input.geoFeature ?? null,
            subTypeCode: input.subTypeCode,
          }),
          targetKind: 'none',
          actorWorkHistoryId: input.actorWorkHistoryId,
          durationMs,
          error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err).slice(0, 500),
        });
      } catch (logErr) {
        this.logger.warn(
          `[LandUseClassifier] error-path ai-usage-log write failed (swallowed): ${logErr instanceof Error ? logErr.message : logErr}`,
        );
      }
      this.storeInCache(cacheKey, null, now + this.FAILURE_TTL_MS);
      return null;
    }

    if (!raw || typeof raw !== 'string') {
      this.logger.warn('[LandUseClassifier] empty response from openai');
      this.storeInCache(cacheKey, null, now + this.FAILURE_TTL_MS);
      return null;
    }

    // ---- parse JSON ----------------------------------------------------
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(
        `[LandUseClassifier] JSON parse failed: ${err instanceof Error ? err.message : err}`,
      );
      this.storeInCache(cacheKey, null, now + this.FAILURE_TTL_MS);
      return null;
    }

    // ---- schema validation ---------------------------------------------
    const validated = this.validateAndSanitize(parsed);
    if (!validated) {
      this.logger.warn(
        `[LandUseClassifier] schema validation failed for tambonCode=${input.adminBoundary.tambonCode}`,
      );
      this.storeInCache(cacheKey, null, now + this.FAILURE_TTL_MS);
      return null;
    }

    // ---- cache success -------------------------------------------------
    this.storeInCache(cacheKey, validated, now + this.SUCCESS_TTL_MS);
    return validated;
  }

  /**
   * Build the USER-role prompt content from structured fields only.
   *
   * §17.9 invariant: no `additionalContext`, no free-form user prose,
   * no arbitrary string of user origin is interpolated here. Only:
   *   - numeric lat/lng
   *   - admin-boundary names / codes (derived from GeoJSON, not user)
   *   - geoFeature enum + Thai name (derived from GeoJSON, not user)
   *   - structured sub-type code from the Wave 24 registry
   */
  private buildUserPrompt(input: ClassifyInput): string {
    const lines: string[] = [
      'โปรดจำแนกประเภทการใช้ประโยชน์ที่ดินของพิกัดต่อไปนี้:',
      '',
      `- พิกัด: lat=${input.lat}, lng=${input.lng}`,
      `- ตำบล: ${input.adminBoundary.tambonName} (code: ${input.adminBoundary.tambonCode})`,
      `- อำเภอ: ${input.adminBoundary.amphoeName} (code: ${input.adminBoundary.amphoeCode})`,
      `- จังหวัด: ${input.adminBoundary.changwatName} (code: ${input.adminBoundary.changwatCode})`,
    ];
    if (input.geoFeature) {
      lines.push(
        `- ลักษณะพื้นที่ใกล้เคียง: ${input.geoFeature.nameTh} (${input.geoFeature.featureType})`,
      );
    }
    if (input.subTypeCode) {
      lines.push(
        `- ประเภทโครงการที่ผู้ใช้เลือก (เพื่อเป็นบริบทเท่านั้น — ห้ามใช้ปรับผลการจำแนก): sub-type ${input.subTypeCode}`,
      );
    }
    lines.push('');
    lines.push('ตอบในรูปแบบ JSON ตามสกีมาที่กำหนด');
    return lines.join('\n');
  }

  /**
   * Strict schema validation + sanitizer application.
   *
   * Returns the sanitized classification on success, `null` on any
   * schema drift. All string fields that originated from the LLM
   * are run through `sanitizeBriefingText` so that echoed prompt
   * markers (e.g. `[GEO_GROUND_TRUTH]`) and criterion IDs are
   * stripped before the value reaches downstream consumers.
   */
  private validateAndSanitize(raw: unknown): LandUseClassification | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    // primaryUse
    const primaryUse = obj.primaryUse;
    if (
      typeof primaryUse !== 'string' ||
      !PRIMARY_USE_VALUES.has(primaryUse as PrimaryUse)
    ) {
      return null;
    }

    // confidence
    const confidence = obj.confidence;
    if (
      typeof confidence !== 'string' ||
      !CONFIDENCE_VALUES.has(confidence as Confidence)
    ) {
      return null;
    }

    // rationale — required, non-empty
    const rationaleRaw = obj.rationale;
    if (typeof rationaleRaw !== 'string' || rationaleRaw.trim().length === 0) {
      return null;
    }
    if (rationaleRaw.length > MAX_RATIONALE_LEN * 4) {
      // Generous upper bound pre-sanitize; sanitizer will trim
      // whitespace but NOT truncate. Reject obvious abuse.
      return null;
    }
    const rationale = sanitizeBriefingText(rationaleRaw);
    if (!rationale) return null;

    // secondaryUse — optional string
    let secondaryUse: string | undefined;
    if (obj.secondaryUse !== undefined && obj.secondaryUse !== null) {
      if (typeof obj.secondaryUse !== 'string') return null;
      if (obj.secondaryUse.length > MAX_SECONDARY_LEN * 4) return null;
      const clean = sanitizeBriefingText(obj.secondaryUse);
      if (clean) {
        secondaryUse = clean.slice(0, MAX_SECONDARY_LEN);
      }
    }

    // landmarks — optional array of strings
    let landmarks: string[] | undefined;
    if (obj.landmarks !== undefined && obj.landmarks !== null) {
      if (!Array.isArray(obj.landmarks)) return null;
      if (obj.landmarks.length > MAX_LANDMARK_COUNT) return null;
      const cleaned: string[] = [];
      for (const item of obj.landmarks) {
        if (typeof item !== 'string') return null;
        if (item.length > MAX_LANDMARK_LEN * 4) return null;
        const s = sanitizeBriefingText(item);
        if (s) cleaned.push(s.slice(0, MAX_LANDMARK_LEN));
      }
      if (cleaned.length > 0) landmarks = cleaned;
    }

    const result: LandUseClassification = {
      primaryUse: primaryUse as PrimaryUse,
      confidence: confidence as Confidence,
      rationale: rationale.slice(0, MAX_RATIONALE_LEN),
    };
    if (secondaryUse) result.secondaryUse = secondaryUse;
    if (landmarks) result.landmarks = landmarks;
    return result;
  }

  /**
   * Insert into cache with FIFO eviction when at capacity. `Map`
   * preserves insertion order, so `keys().next().value` is always
   * the oldest key.
   */
  private storeInCache(
    key: string,
    value: LandUseClassification | null,
    expiresAt: number,
  ): void {
    if (this.cache.size >= this.CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * Wave 35 N1 — cache-hit-only peek for `POST /ai/geo-preview`.
   *
   * Returns the cached classification without firing a fresh OpenAI
   * call. Returns `null` on miss, expired entry, failure-cached
   * null, or when either code is missing.
   *
   * Constraints (hard):
   *   - MUST NEVER invoke `openai.chat.completions.create`
   *   - MUST NEVER insert a new cache entry
   *   - MUST NEVER extend the TTL of an existing entry (pure read)
   *   - MUST NOT log per-call (classify() already logs its misses;
   *     preview should be silent to avoid log-volume amplification)
   *
   * §17.5 — preview MUST NOT trigger involuntary auto-recompute;
   * this accessor is the enforcement hook.
   */
  peekCache(
    amphoeCode: string | null | undefined,
    tambonCode: string | null | undefined,
  ): LandUseClassification | null {
    if (!amphoeCode || !tambonCode) return null;
    const key = `${amphoeCode}:${tambonCode}`;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    // `entry.value` may itself be null (failure placeholder) —
    // returning null is the correct "no hint" signal for the
    // preview use case.
    return entry.value;
  }

  /**
   * Test-only helper: expose cache size so the LRU-cap spec can
   * assert eviction without reaching into private state via `any`.
   */
  _cacheSizeForTest(): number {
    return this.cache.size;
  }

  /**
   * Test-only helper: expose whether a given cache key is present.
   */
  _cacheHasForTest(key: string): boolean {
    return this.cache.has(key);
  }
}
