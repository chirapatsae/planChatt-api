import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  forwardRef,
} from '@nestjs/common';
// PRIV-W44-01 — central LLM abstraction (CLAUDE.md §17). The direct
// OpenAI constructor now lives exclusively in `OpenAILlmClient`.
import { LLM_CLIENT, LlmClient } from './llm/llm-client.interface';
import { PreSubmitReviewDto } from './dto/pre-submit-review.dto';
import { SmartApproveRequestDto } from './dto/smart-approve.dto';
import { SmartApprovePrecheckService } from './smart-approve-precheck.service';
import { IssueCriteriaRegistryService } from './criteria/issue-criteria-registry.service';
import { IssueCriteriaGeoCheckService } from './criteria/issue-criteria-geo-check.service';
import {
  EvidenceAttachmentInput,
  IssueCriteriaEvidenceCheckService,
} from './criteria/issue-criteria-evidence-check.service';
import {
  composeCriteriaContextBlock,
  composeExamplesSection,
} from './criteria/compose-criteria-context';
import {
  CriteriaEvaluationPayload,
  CriterionHint,
  CriterionResult,
  CriterionSource,
  CriterionVerdict,
  IssueRuleEntry,
} from './criteria/issue-criteria.types';
import { formatRubricForReviewer } from './utils/quality-rubric';
import { calculateAiCost } from './utils/cost-calculator';
import { getUsdToThbFx } from 'src/ai-usage-quotas/fx-config';
import {
  computeSmartApproveContentHash,
  ContentHashInput,
} from './utils/content-hash';
import { AiUsageQuotasService } from 'src/ai-usage-quotas/ai-usage-quotas.service';
import { AiUsageLogsService } from 'src/ai-usage-logs/ai-usage-logs.service';
import { composeSummaryTh } from 'src/ai-usage-logs/summary-th.util';
import { sanitizeRequestPayload } from 'src/ai-usage-logs/sanitize-request-payload.util';
import { scoreToBand } from './utils/ai-score-envelope';
// Wave LAO-STRATEGY-AI-PARITY Followup G+R Coherence (2026-05-22) —
// deterministic readinessLabel band computation shared with
// AiService.generatePreSubmitReview. Overrides whatever the LLM supplies
// so the numeric score and the band chip can never disagree. See module
// header in `utils/readiness-label.ts` for full rationale.
import { deriveReadinessLabel } from './utils/readiness-label';
// §17.9 — shared delimiter envelope + embedded-token sanitization.
// The literal `<<<USER_INPUT>>>` / `<<<END>>>` tokens live exclusively
// in `wrap-user-text.ts` so owner and staff pipelines cannot drift.
import { wrapUserText as sharedWrapUserText } from './utils/wrap-user-text';
// SEC-W44-02 — INPUT-side PII redactor (§17.9 complement to delimiter
// wrap).  Order: redact → wrap → dispatch.
import { PiiRedactorService } from 'src/common/pii/pii-redactor.service';

/**
 * Wave 41 N3 — Staff reviewer prompt builder & executor.
 *
 * Mirrors the owner-side `AiService.generatePreSubmitReview` shape so
 * the frontend `ResultBody` can render both owner and staff envelopes
 * identically (drift banner depends on shared rubric — that is the
 * whole point).
 *
 * What is INTENTIONALLY different from the owner path:
 *   - System-prompt **reframing** — the model is told to act as a
 *     reviewer (ผู้ตรวจประเมิน), not as an owner-side assistant.
 *     The rubric block, schema, and user-payload wrapping remain
 *     byte-identical to the owner path so scores are comparable.
 *   - Endpoint label — `staff-review/analyze` for cooldown, usage
 *     logging, envelope provenance (§17.10).
 *
 * CLAUDE.md references:
 *   - §16.5 — ISSUE_BASED reads `developmentIssue`, omits `indicator`;
 *     STRATEGY_BASED reads `strategy/tactic/plan/indicator`.
 *   - §17.2 — advisory-only; the produced score NEVER gates workflow.
 *   - §17.9 — user-sourced text is wrapped in
 *     `<<<USER_INPUT>>>...<<<END>>>`; AI output is JSON-schema-validated
 *     server-side; schema drift raises 502 `AI_SCHEMA_DRIFT` with no
 *     silent coercion.
 *   - §17.10 — output carries score + band + endpoint + computedAt +
 *     stalenessPolicy (added downstream in the envelope composer).
 *   - §17.11 — no role exemption; the service is pure compute with
 *     no authority hooks.
 *
 * The owner path (`AiService.generatePreSubmitReview`) is NOT touched by
 * this service — Wave 41 is strictly additive.
 */
@Injectable()
export class StaffReviewPromptService {
  private readonly logger = new Logger(StaffReviewPromptService.name);

  /** §17.9 cap on user-controlled free-text before hashing / prompt-wrap. */
  private static readonly USER_CONTEXT_CAP = 2000;

  constructor(
    private readonly precheckService: SmartApprovePrecheckService,
    private readonly issueCriteriaRegistry: IssueCriteriaRegistryService,
    private readonly geoCheckService: IssueCriteriaGeoCheckService,
    private readonly evidenceCheckService: IssueCriteriaEvidenceCheckService,
    private readonly aiUsageQuotasService: AiUsageQuotasService,
    @Inject(forwardRef(() => AiUsageLogsService))
    private readonly aiUsageLogsService: AiUsageLogsService,
    // PRIV-W44-01 — central LLM client.
    @Inject(LLM_CLIENT)
    private readonly llm: LlmClient,
    // SEC-W44-02 — INPUT-side PII redactor.
    private readonly piiRedactor: PiiRedactorService,
  ) {}

  /**
   * Envelope shape returned to the controller. Matches the owner
   * pre-submit response contract so FE can reuse `ResultBody`.
   */
  // (intentionally exposed via the return type of executeStaffReview)

  // ─────────────────────────────────────────────────────────────────
  // Public — pure prompt builder (deterministic for a fixed DTO).
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build the reviewer-framed system + user prompt.
   *
   * Returns `{ systemPrompt, userPrompt, matchedRule, criterionHints,
   * checklistSummary, responseSchema, contentHash }` so the executor
   * can feed OpenAI and merge downstream verdicts.
   */
  async buildStaffReviewPrompt(dto: PreSubmitReviewDto): Promise<{
    systemPrompt: string;
    userPrompt: string;
    matchedRule: IssueRuleEntry | null;
    criterionHints: CriterionHint[];
    checklistSummary: Array<{ label: string; passed: boolean }>;
    responseSchema: {
      name: string;
      strict?: boolean;
      schema: Record<string, unknown>;
    };
    contentHash: string;
  }> {
    const isIssueBased = dto.reportFormat === 'ISSUE_BASED';
    const { project } = dto;

    // Cap user-controlled free text before it is hashed / embedded
    // (§17.9 — bound injection surface).
    const cappedAdditionalContext = this.capUserText(dto.additionalContext);

    // ── Procedural precheck (reuses the canonical rule set) ────────
    const smartApproveCompatDto: SmartApproveRequestDto = {
      strategyName: dto.strategyName,
      tacticName: dto.tacticName,
      planName: dto.planName,
      developmentIssueName: dto.developmentIssueName,
      project: dto.project,
      additionalContext: cappedAdditionalContext,
    };
    const precheck = await this.precheckService.evaluate(smartApproveCompatDto);

    const CATEGORY_LABELS: Record<string, string> = {
      strategy: 'ยุทธศาสตร์/กลยุทธ์',
      projectInfo: 'ข้อมูลโครงการ',
      location: 'พิกัดที่ตั้ง',
      budget: 'งบประมาณ',
      indicators: 'ตัวชี้วัด',
    };
    const checklistSummary = Object.entries(precheck.response.categories)
      .filter(([key]) => {
        if (isIssueBased && (key === 'strategy' || key === 'indicators'))
          return false;
        return true;
      })
      .map(([key, cat]) => ({
        label: CATEGORY_LABELS[key] ?? key,
        passed: cat.status === 'ผ่าน',
      }));

    // ── Criteria registry lookup (ISSUE_BASED only) ────────────────
    let matchedRule: IssueRuleEntry | null = null;
    let criterionHints: CriterionHint[] = [];
    if (isIssueBased) {
      try {
        if (dto.developmentIssueId) {
          const lookup = await this.issueCriteriaRegistry.findByIssueId(
            dto.developmentIssueId,
          );
          matchedRule = lookup.entry;
        } else if (dto.developmentIssueName) {
          matchedRule = this.issueCriteriaRegistry.findByIssueName(
            dto.developmentIssueName,
          );
        }
      } catch (err) {
        this.logger.warn(
          `[staff-review] registry lookup failed; skipping criteria injection: ${
            err instanceof Error ? err.message : err
          }`,
        );
        matchedRule = null;
      }
      if (matchedRule) {
        try {
          const geoHints = this.geoCheckService.evaluate(matchedRule, {
            startLat: project.startLat ?? null,
            startLng: project.startLng ?? null,
            endLat: project.endLat ?? null,
            endLng: project.endLng ?? null,
          });
          const evidenceAttachments: EvidenceAttachmentInput[] = (
            dto.attachments ?? []
          ).map((a) => ({
            id: a.id,
            aiTopic: a.aiTopic ?? null,
            aiSummary: a.aiSummary ?? null,
            evidenceLink: a.evidenceLink ?? null,
          }));
          const evidenceHints = this.evidenceCheckService.evaluate(
            matchedRule,
            evidenceAttachments,
          );
          criterionHints = [...geoHints, ...evidenceHints];
        } catch (err) {
          this.logger.warn(
            `[staff-review] pre-check evaluation failed; continuing without hints: ${
              err instanceof Error ? err.message : err
            }`,
          );
          criterionHints = [];
        }
      }
    }

    // ── Prompt composition ─────────────────────────────────────────
    const totalBudget = (project.budgets ?? []).reduce(
      (sum, b) => sum + (b.quantity ?? 0),
      0,
    );
    const budgetLines = (project.budgets ?? [])
      .map(
        (b) =>
          `  - ปี ${b.year}: ${b.quantity.toLocaleString('th-TH')} บาท`,
      )
      .join('\n');

    // §16.5 branching on classification shape.
    const classificationBlock = isIssueBased
      ? `- ประเด็นการพัฒนา: ${this.wrapUserText(dto.developmentIssueName)}`
      : [
          `- ยุทธศาสตร์: ${this.wrapUserText(dto.strategyName)}`,
          `- กลยุทธ์: ${this.wrapUserText(dto.tacticName)}`,
          `- แผนงาน: ${this.wrapUserText(dto.planName)}`,
        ].join('\n');
    const indicatorLine = isIssueBased
      ? ''
      : `- ตัวชี้วัด: ${this.wrapUserText(project.indicator)}`;

    const fieldGuidance = isIssueBased
      ? '"วัตถุประสงค์", "เป้าหมาย", "งบประมาณ", "ชื่อโครงการ", "ผลที่คาดว่าจะได้รับ"'
      : '"วัตถุประสงค์", "เป้าหมาย", "งบประมาณ", "ชื่อโครงการ", "ผลที่คาดว่าจะได้รับ", "ตัวชี้วัด"';

    // ── System prompt reframing (the Wave 41 headline change) ──────
    // Wave 24 criteria context + hints are SYSTEM-generated trusted
    // strings; they go UNDELIMITED per §17.9. User-sourced text is
    // wrapped below inside the user message only.
    const subTypeUserInputAggregate = [
      project.title,
      project.objective,
      project.goal,
      project.expected,
      cappedAdditionalContext,
    ]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .join('\n');

    const criteriaContextBlock = matchedRule
      ? composeCriteriaContextBlock(matchedRule, {
          subTypeCode: dto.subTypeCode,
          userInputText: subTypeUserInputAggregate,
          examplesBlock: composeExamplesSection(matchedRule, dto.subTypeCode),
        })
      : '';
    const criteriaJsonBlock = matchedRule
      ? `[CRITERIA_JSON]\n${JSON.stringify(
          matchedRule.criteria.map((c) => ({
            id: c.id,
            label: c.label,
            description: c.description,
            criticality: c.criticality,
            evidenceRequired: c.evidenceRequired,
          })),
        )}`
      : '';
    const hintsJsonBlock =
      matchedRule && criterionHints.length > 0
        ? `[HINTS_JSON]\n${JSON.stringify(
            criterionHints.map((h) => ({
              criterionId: h.criterionId,
              suggestedVerdict: h.suggestedVerdict,
              reason: h.reason,
              kind: h.kind,
            })),
          )}`
        : '';
    const criteriaInstructionBlock = matchedRule
      ? [
          '[CRITERIA_OUTPUT_RULES]',
          '- สำหรับทุกเกณฑ์ใน [CRITERIA_JSON] ให้ระบุผลใน field "criteria" ของ JSON ตอบกลับ',
          '- verdict ∈ {pass, fail, needs-evidence, not-applicable}',
          '- ใช้ criterionId ตรงตามที่ให้มาเท่านั้น (ห้ามสร้างรหัสใหม่)',
          '- ถ้ามี HINTS_JSON ให้ใช้เป็นบริบทหลัก เว้นแต่จะมีหลักฐานคัดค้านชัดเจนในเนื้อหาโครงการ',
          '- ถ้าไม่แน่ใจ → needs-evidence',
          '- ผลลัพธ์ต้องครบถ้วนทุกเกณฑ์ และห้ามส่ง field criteria เมื่อไม่ได้รับ [CRITERIA_JSON]',
        ].join('\n')
      : '';
    const criteriaSystemTail = [
      criteriaContextBlock,
      criteriaJsonBlock,
      hintsJsonBlock,
      criteriaInstructionBlock,
    ]
      .filter(Boolean)
      .join('\n\n');

    const systemPrompt =
      'คุณคือผู้ตรวจประเมินโครงการภาครัฐส่วนท้องถิ่น (อปท.) มีหน้าที่ประเมินคุณภาพของโครงการที่ผู้ส่งนำเสนอ ตามกรอบการตรวจของราชการไทย โดยเน้นมุมมองของผู้ตรวจ (reviewer) ไม่ใช่มุมมองของเจ้าของโครงการ ใช้ภาษาราชการไทยที่สุภาพ กระชับ และตรงประเด็น ตอบเป็น JSON เท่านั้น' +
      (criteriaSystemTail ? `\n\n${criteriaSystemTail}` : '');

    // ── User prompt — §17.9 delimited user data ────────────────────
    // All user-sourced fields are wrapped inside <<<USER_INPUT>>>…<<<END>>>
    // so the LLM treats them as data, not instructions. Budget totals
    // and budget year breakdown are system-computed (numeric), so they
    // stay outside the delimiter.
    const userPrompt = `ประเมินคุณภาพของโครงการต่อไปนี้ในมุมมองของผู้ตรวจ (reviewer) และให้คำแนะนำเชิงสร้างสรรค์:

ข้อมูลโครงการ:
- ชื่อโครงการ: ${this.wrapUserText(project.title)}
- วัตถุประสงค์: ${this.wrapUserText(project.objective)}
- เป้าหมาย: ${this.wrapUserText(project.goal)}
- ผลที่คาดว่าจะได้รับ: ${this.wrapUserText(project.expected || '(ไม่ระบุ)')}
${indicatorLine}
${classificationBlock}
- งบประมาณรวม: ${totalBudget.toLocaleString('th-TH')} บาท
${budgetLines ? `  รายปี:\n${budgetLines}` : ''}

บริบทเพิ่มเติม (ผู้ส่งแนบมา):
${this.wrapUserText(cappedAdditionalContext || '(ไม่มี)')}

หมายเหตุงบประมาณ: รายการ "ปี YYYY: X บาท" ข้างบนคือการจัดสรรรายปีแบบสมบูรณ์ตามโครงสร้างข้อมูลของระบบ (budgets: { year, quantity }[]) ห้ามแนะนำให้ "ระบุเพิ่ม" / "จัดสรรรายปี" / "แจกแจงรายกิจกรรม" ให้พิจารณาเฉพาะความสมเหตุสมผลของยอดรวมเทียบกับขอบเขตเท่านั้น

${formatRubricForReviewer({ isIssueBased })}

เกณฑ์การประเมิน (มุมมองผู้ตรวจ):
1. overallScore (0–100) — คะแนนคุณภาพรวมของโครงการ
2. readinessLabel — กำหนดตามคะแนน: "พร้อมส่ง" (85–100), "ควรปรับปรุง" (60–84), "ต้องแก้ไขก่อนส่ง" (0–59)
3. rationale — สรุปภาพรวม 2–3 ประโยค ในฐานะผู้ตรวจ ระบุจุดแข็งและจุดที่ต้องพัฒนาอย่างเป็นกลาง
4. strongPoint — ระบุจุดเด่นที่ดีที่สุดของโครงการ 1 ประโยคกระชับ
5. suggestions — ให้ 0–5 ข้อแนะนำ เฉพาะช่องว่างที่ชัดเจนและปฏิบัติได้จริง แต่ละข้อระบุ:
   - field: ฟิลด์ที่เกี่ยวข้อง (ตัวอย่าง: ${fieldGuidance})
   - message: คำแนะนำสั้น ๆ กระชับ ไม่เกิน 60 คำ ต้องอ้างอิงช่องว่างที่เป็นรูปธรรมของโครงการ
   - priority: "high" ถ้าจำเป็นต้องแก้ไข, "medium" ถ้าควรปรับปรุง, "low" ถ้าเป็นข้อเสนอเสริม

ข้อกำหนดจำนวนข้อแนะนำตามคะแนน (บังคับ):
- ถ้า overallScore ≥ 85 ต้องมี suggestions ≤ 2 ข้อ และต้องเป็น priority='high' เท่านั้น; ถ้า 70–84 ≤ 3 ข้อ; ถ้า < 70 ค่อยให้ 3–5 ข้อ
- 0 ข้อเป็นคำตอบที่ยอมรับได้เมื่อเนื้อหาทุกฟิลด์ผ่านเกณฑ์แล้ว

วลีต่อไปนี้เกี่ยวข้องกับ "หลักฐาน / เอกสารแนบ / รูปถ่าย" — ห้ามใช้ในข้อแนะนำโดยเด็ดขาด (Wave Evidence-Scope Decoupling 2026-05-22):
- "ควรระบุหลักฐาน..."
- "ควรแนบเอกสาร..."
- "ควรแสดงหลักฐาน..."
- "ควรเพิ่มหลักฐาน..."
- "ควรแนบรูปถ่าย / ใบอนุญาต / สำเนา..."
- "ควรมีเอกสารยืนยัน..."
- "ควรแนบไฟล์..."
เหตุผล: เอกสารแนบ / หลักฐานเป็นความรับผิดชอบของเจ้าหน้าที่ผู้ตรวจสอบที่จะตรวจของจริงในขั้นตอนถัดไป — AI ไม่มีสิทธิ์เข้าถึงไฟล์แนบและไม่มีหน้าที่ตรวจ AI มีหน้าที่ตรวจคุณภาพ "เนื้อหา prose" ที่ผู้ใช้แก้ไขได้ทันทีเท่านั้น
หากเกณฑ์ใดต้องการ "evidence" (เช่น หลักฐานสิทธิ์ที่ดิน ใบอนุญาตใช้พื้นที่ ใบรับรอง) — ให้ข้ามเกณฑ์นั้นในการให้ suggestions (ระบบมีกลไกตรวจการแนบไฟล์แยกต่างหาก) แต่ยังให้ verdict ในผลลัพธ์ criteria ได้ตามปกติ
หากวลีข้างต้นปรากฏในข้อแนะนำ ให้ตัดข้อนั้นออกจาก suggestions ทันที

วลีต่อไปนี้เกี่ยวข้องกับ "การอ้างอิงระเบียบ / มาตรฐาน / กฎหมาย / พ.ร.บ. / พ.ศ." — ห้ามใช้ในข้อแนะนำเป็นรายฟิลด์โดยเด็ดขาด (Wave Field-Scope Decoupling 2026-05-22):
- "ควรระบุมาตรฐาน..."
- "ควรอ้างอิงระเบียบ / กฎหมาย / พ.ร.บ. ..."
- "ควรอ้างถึงพระราชบัญญัติ..."
- "ควรระบุตามมาตรฐาน..." (เมื่อ "..." เป็นมาตรฐานทางเทคนิค / กรม / กฎหมาย)
- "ควรเป็นไปตามมาตรฐาน..."
- "ควรสอดคล้องกับระเบียบ..."
เหตุผล: ระเบียบ / มาตรฐาน / กฎหมายเป็นข้อมูลพื้นหลัง (background / rationale) ของโครงการ ไม่ใช่เนื้อหาที่ผู้ใช้กรอกในฟิลด์ "วัตถุประสงค์" / "เป้าหมาย" / "ผลที่คาดว่าจะได้รับ" / "ตัวชี้วัด" — ฟิลด์เหล่านี้เป็นการบรรยายโครงการเอง ไม่ใช่ภาพรวมระเบียบ ระบบไม่มีฟิลด์ "หลักการและเหตุผล" ให้ผู้ใช้กรอก ดังนั้นการบอกให้ "ใส่ระเบียบ" จึงเป็นคำแนะนำที่ผู้ใช้แก้ไม่ได้
หากเกณฑ์ใดเป็นเรื่อง "compliance / มาตรฐานทางเทคนิค / การปฏิบัติตามกฎหมาย" — ให้ verdict เป็น "not-applicable" พร้อม rationale ว่า "ตรวจสอบโดยเจ้าหน้าที่ในขั้นตอน review จากเอกสารแนบของผู้ใช้" และข้ามเกณฑ์นั้นในการให้ suggestions ห้ามให้ verdict เป็น "fail" หรือ "needs-evidence" สำหรับเกณฑ์ประเภทนี้
หากวลีข้างต้นปรากฏในข้อแนะนำ ให้ตัดข้อนั้นออกจาก suggestions ทันที

หลักการ Field-Scope (Wave Field-Scope Decoupling 2026-05-22) — ก่อนเขียนข้อแนะนำในแต่ละ field ให้ถามว่า "เนื้อหาที่แนะนำตรงตามเจตนาของฟิลด์หรือไม่?":
- "วัตถุประสงค์" = WHAT โครงการจะทำ + กิจกรรม + กลุ่มเป้าหมาย + ผู้ประสานงาน + ระยะเวลา → ห้ามแนะนำ "ระเบียบ" "มาตรฐาน" "หลักฐาน"
- "เป้าหมาย" = ตัวเลขเป้าหมาย + ตัวชี้วัด + ค่าฐาน + ระยะเวลาวัดผล + ขอบเขตพื้นที่ → ห้ามแนะนำ "ระเบียบ" "หลักฐาน"
- "ผลที่คาดว่าจะได้รับ" = ประโยชน์ทางตรง/อ้อม + ระยะสั้น/กลาง/ยาว + กลไก + ตัวชี้วัด → ห้ามแนะนำ "ระเบียบ" "หลักฐาน"
- "ตัวชี้วัด" = ค่าฐาน + ค่าเป้าหมาย + วิธีวัด + แหล่งอ้างอิงข้อมูล (หน่วยงานราชการ) → ห้ามแนะนำ "ระเบียบ" "หลักฐาน"
- "งบประมาณ" = ตัวเลขสมเหตุสมผลกับขอบเขต → ห้ามแนะนำ "แจกแจงรายกิจกรรม" "ระเบียบ"
หากเนื้อหาที่จะแนะนำไม่ตรงกับฟิลด์ใดในรายการข้างต้น — ห้ามใส่ใน suggestions เพราะผู้ใช้แก้ไม่ได้ในฟอร์มที่มีอยู่

วิธีตีความข้อความที่มีแท็ก "(ตัวอย่างจาก AI — โปรดยืนยัน)" (Wave LAO-STRATEGY-AI-PARITY Followup G+R Coherence 2026-05-22):
- ฝั่งสร้าง (Generator) อาจใส่แท็กนี้ต่อท้ายค่าที่ AI เป็นผู้เสนอ (เช่น ชื่อระบบ ชื่อแหล่งอ้างอิง) เพื่อแจ้งผู้ส่งให้ตรวจสอบก่อนนำส่ง
- ให้ถือว่าค่าที่อยู่ก่อนแท็กเป็น "เนื้อหาที่กรอกครบ" — pass หลักเกณฑ์ที่เกี่ยวข้องตามปกติ ห้ามตัดสินว่าเป็น "ขาดข้อมูล"
- ห้ามแนะนำให้ "ลบแท็ก" หรือ "ระบุข้อมูลให้ชัดเจน" เพียงเพราะเห็นแท็กนี้ — แท็กเป็นเครื่องหมายให้ผู้ใช้ ไม่ใช่ช่องว่างของเนื้อหา
- จะตำหนิเฉพาะเมื่อค่าตัวอย่างที่อยู่ก่อนแท็กไม่สมเหตุสมผลกับบริบท เช่น ชื่อระบบที่ไม่มีจริง หรือแหล่งอ้างอิงปลอม

หมายเหตุ: ประเมินจากเนื้อหาจริง ไม่ใช่แค่ตรวจว่ากรอกหรือไม่ ให้คำแนะนำที่เป็นประโยชน์และปฏิบัติได้จริงในบริบท อปท.`.trim();

    // ── Response schema ────────────────────────────────────────────
    const baseProperties: Record<string, unknown> = {
      overallScore: { type: 'integer' as const },
      readinessLabel: {
        type: 'string' as const,
        enum: ['พร้อมส่ง', 'ควรปรับปรุง', 'ต้องแก้ไขก่อนส่ง'],
      },
      rationale: { type: 'string' as const },
      strongPoint: { type: 'string' as const },
      suggestions: {
        type: 'array' as const,
        maxItems: 5,
        items: {
          type: 'object' as const,
          properties: {
            field: { type: 'string' as const },
            message: { type: 'string' as const },
            priority: {
              type: 'string' as const,
              enum: ['high', 'medium', 'low'],
            },
          },
          required: ['field', 'message', 'priority'],
          additionalProperties: false,
        },
      },
    };
    const baseRequired = [
      'overallScore',
      'readinessLabel',
      'rationale',
      'strongPoint',
      'suggestions',
    ];
    if (matchedRule) {
      baseProperties.criteria = {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            criterionId: { type: 'string' as const },
            verdict: {
              type: 'string' as const,
              enum: ['pass', 'fail', 'needs-evidence', 'not-applicable'],
            },
            rationale: { type: 'string' as const },
          },
          required: ['criterionId', 'verdict', 'rationale'],
          additionalProperties: false,
        },
      };
      baseRequired.push('criteria');
    }
    const responseSchema = {
      name: 'StaffReview',
      strict: true,
      schema: {
        type: 'object' as const,
        properties: baseProperties,
        required: baseRequired,
        additionalProperties: false,
      },
    };

    // ── Content hash (shared with owner path) ──────────────────────
    const contentHash = this.computeReviewContentHash(dto, cappedAdditionalContext);

    return {
      systemPrompt,
      userPrompt,
      matchedRule,
      criterionHints,
      checklistSummary,
      responseSchema,
      contentHash,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Public — execute (LLM call + schema validation + merge)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Run the staff reviewer pipeline end-to-end for a fresh LLM call.
   *
   * Controller is responsible for cache-first lookup; this method is
   * invoked only on cache miss or explicit `recompute=true`.
   */
  async executeStaffReview(
    dto: PreSubmitReviewDto,
    reviewerUserId: string,
  ): Promise<{
    overallScore: number;
    readinessLabel: string;
    rationale: string;
    strongPoint: string;
    suggestions: Array<{
      field: string;
      message: string;
      priority: 'high' | 'medium' | 'low';
    }>;
    checklistSummary: Array<{ label: string; passed: boolean }>;
    categories?: { criteriaEvaluation?: CriteriaEvaluationPayload };
    contentHash: string;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
  }> {
    const built = await this.buildStaffReviewPrompt(dto);
    const {
      systemPrompt,
      userPrompt,
      matchedRule,
      criterionHints,
      checklistSummary,
      responseSchema,
      contentHash,
    } = built;

    // SEC-W44-02 — §17.9 PII redaction on the staff-review user prompt.
    // User-sourced text (project fields, attachment OCR summaries,
    // reviewer's additionalContext) is already delimiter-wrapped; this
    // pass strips citizen IDs / phones / emails / postal / address
    // fragments from INSIDE the delimiters before LLM dispatch.
    const { output: redactedReviewerPrompt } = this.piiRedactor.redactText(
      userPrompt,
      { endpoint: 'staff-review/analyze' },
    );

    const startTime = Date.now();
    try {
      const completion = await this.llm.createChatCompletion({
        model: 'gpt-4o',
        temperature: 0.3,
        max_tokens: 1500,
        response_format: { type: 'json_schema', json_schema: responseSchema },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: redactedReviewerPrompt },
        ],
      });
      const durationMs = Date.now() - startTime;

      const content = completion.choices[0].message?.content;
      if (!content) {
        throw new InternalServerErrorException(
          'ไม่สามารถประมวลผลการตรวจสอบโครงการได้',
        );
      }

      // §17.9 — JSON validation. Schema drift (non-JSON OR missing
      // required field OR wrong type) → 502 AI_SCHEMA_DRIFT with NO
      // silent coercion. The LLM-returned "overallScore" is trusted
      // ONLY after the shape check below clears.
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new HttpException(
          { code: 'AI_SCHEMA_DRIFT', message: 'AI output is not valid JSON' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      this.assertResponseShape(parsed, Boolean(matchedRule));

      const aiResult = parsed as {
        overallScore: number;
        readinessLabel: 'พร้อมส่ง' | 'ควรปรับปรุง' | 'ต้องแก้ไขก่อนส่ง';
        rationale: string;
        strongPoint: string;
        suggestions: Array<{
          field: string;
          message: string;
          priority: 'high' | 'medium' | 'low';
        }>;
        criteria?: Array<{
          criterionId: string;
          verdict: string;
          rationale: string;
        }>;
      };

      // Merge criteria verdicts + deterministic hints. Unknown ids /
      // verdicts raise 502 AI_SCHEMA_DRIFT per §17.9.
      let criteriaEvaluation: CriteriaEvaluationPayload | null = null;
      let overallScoreAdjustment = 0;
      if (matchedRule) {
        criteriaEvaluation = this.mergeCriteriaResults(
          matchedRule,
          criterionHints,
          aiResult.criteria ?? [],
        );
        overallScoreAdjustment = this.computeCriticalityPenalty(
          matchedRule,
          criteriaEvaluation.results,
        );
      }

      const adjustedScore = Math.min(
        100,
        Math.max(
          0,
          Math.round(aiResult.overallScore + overallScoreAdjustment),
        ),
      );

      // Usage logging + cost (§17.3 audit separation — ai_usage_logs
      // only; no tracking_status write).
      let costThb = 0;
      if (completion.usage) {
        const costUsd = calculateAiCost('gpt-4o', completion.usage);
        costThb = costUsd * getUsdToThbFx();
        await this.aiUsageQuotasService.checkAndLogUsage(
          reviewerUserId,
          costUsd,
        );
      }
      const quotaId = await this.aiUsageQuotasService.findQuotaIdByUserId(
        reviewerUserId,
      );
      await this.writeDetailLog({
        modelName: 'gpt-4o',
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        inputTextLength: (systemPrompt?.length ?? 0) + (userPrompt?.length ?? 0),
        outputTextLength: content.length,
        costBaht: costThb,
        aiUsageQuotaId: quotaId ?? undefined,
        title: dto.project?.title,
        dto,
        matchedRule: Boolean(matchedRule),
        overallScore: adjustedScore,
        // NOTE — the audit row captures the LLM's RAW label (observability),
        // NOT the deterministic label that the response returns (Wave
        // LAO-STRATEGY-AI-PARITY Followup G+R Coherence 2026-05-22 derives
        // the response label from `adjustedScore`). Logging the LLM raw
        // lets ops detect schema drift / hallucination on the label
        // independently of the deterministic response override. The two
        // values MAY diverge by design — that divergence is itself useful
        // signal for ops.
        readinessLabel: aiResult.readinessLabel,
        suggestionsCount: aiResult.suggestions?.length ?? 0,
        durationMs,
      });

      // Strip raw `criteria` from spread; structured payload goes under
      // categories.criteriaEvaluation only.
      const { criteria: _raw, ...aiResultBase } = aiResult;
      void _raw;

      // Wave LAO-STRATEGY-AI-PARITY Followup G+R Coherence (2026-05-22) —
      // derive readinessLabel deterministically from the post-adjustment
      // score and OVERRIDE the LLM-supplied value. Matches the parity fix
      // in AiService.generatePreSubmitReview so owner-side and staff-side
      // review paths share identical band semantics. Advisory-only per
      // §17.2 — does NOT gate any workflow transition.
      const derivedReadinessLabel = deriveReadinessLabel(adjustedScore);

      return {
        ...aiResultBase,
        overallScore: adjustedScore,
        readinessLabel: derivedReadinessLabel,
        checklistSummary,
        ...(criteriaEvaluation
          ? { categories: { criteriaEvaluation } }
          : {}),
        contentHash,
        model: completion.model || 'gpt-4o',
        usage: {
          prompt_tokens: completion.usage?.prompt_tokens ?? 0,
          completion_tokens: completion.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const quotaId = await this.aiUsageQuotasService.findQuotaIdByUserId(
        reviewerUserId,
      );
      await this.writeDetailLog({
        modelName: 'gpt-4o',
        inputTokens: 0,
        outputTokens: 0,
        inputTextLength: (systemPrompt?.length ?? 0) + (userPrompt?.length ?? 0),
        outputTextLength: 0,
        costBaht: 0,
        aiUsageQuotaId: quotaId ?? undefined,
        title: dto.project?.title,
        dto,
        matchedRule: Boolean(matchedRule),
        overallScore: null,
        readinessLabel: null,
        suggestionsCount: 0,
        durationMs,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 500)
            : String(error).slice(0, 500),
      });
      if (error instanceof HttpException) throw error;
      this.logger.error('executeStaffReview failed:', error);
      throw new InternalServerErrorException(
        'เกิดข้อผิดพลาดในการวิเคราะห์คุณภาพโครงการ',
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────

  /**
   * Compute the content hash from the reviewer DTO using the shared
   * owner-path util. Same project content + same classification +
   * same attachment OCR state ⇒ same hash across owner and staff
   * endpoints. Wave 41 drift banner depends on this parity.
   */
  private computeReviewContentHash(
    dto: PreSubmitReviewDto,
    cappedAdditionalContext: string,
  ): string {
    const input: ContentHashInput = {
      project: {
        title: dto.project.title ?? null,
        objective: dto.project.objective ?? null,
        goal: dto.project.goal ?? null,
        expected: dto.project.expected ?? null,
        indicator: dto.project.indicator ?? null,
        startLat: dto.project.startLat ?? null,
        startLng: dto.project.startLng ?? null,
        endLat: dto.project.endLat ?? null,
        endLng: dto.project.endLng ?? null,
        amphoeId: dto.project.amphoeId ?? null,
        localOrganizationId: dto.project.localOrganizationId ?? null,
        budgets: Array.isArray(dto.project.budgets)
          ? dto.project.budgets
          : [],
      },
      classification: {
        reportFormat: dto.reportFormat ?? 'STRATEGY_BASED',
        strategyName: dto.strategyName ?? null,
        tacticName: dto.tacticName ?? null,
        planName: dto.planName ?? null,
        developmentIssueName: dto.developmentIssueName ?? null,
      },
      attachments: Array.isArray(dto.attachments)
        ? dto.attachments.map((a) => ({
            id: a.id,
            aiTopic: a.aiTopic ?? null,
            aiSummary: a.aiSummary ?? null,
          }))
        : [],
      // Reviewer includes additionalContext in the hash surface so
      // that a reviewer editing/adding their own note yields a fresh
      // cached run. Owner path sets justification=null, so owner and
      // staff hashes coincide when additionalContext is empty.
      justification: cappedAdditionalContext || null,
    };
    return computeSmartApproveContentHash(input);
  }

  /**
   * §17.9 — wrap user-sourced text inside the delimiter envelope.
   * Delegates to the shared helper in `utils/wrap-user-text.ts` which
   * is also consumed by the owner-side `AiService`, guaranteeing that
   * the delimiter policy and embedded-token sanitation cannot drift
   * between the two pipelines.
   *
   * Wave 41 N8 — delimiter-injection defense (shared helper): the
   * body is sanitized BEFORE wrapping so an attacker cannot inject a
   * literal `<<<END>>> …instruction… <<<USER_INPUT>>>` pair to escape
   * the envelope. Empty / null inputs collapse to `(ไม่ระบุ)` wrapped
   * in delimiters so the schema contract stays stable.
   */
  private wrapUserText(value: string | null | undefined): string {
    return sharedWrapUserText(value);
  }

  private capUserText(value: string | null | undefined): string {
    const raw = typeof value === 'string' ? value : '';
    return raw.slice(0, StaffReviewPromptService.USER_CONTEXT_CAP);
  }

  /**
   * Strict shape assertion for the LLM response. Throws 502
   * AI_SCHEMA_DRIFT on violation (never coerces).
   */
  private assertResponseShape(parsed: unknown, withCriteria: boolean): void {
    if (!parsed || typeof parsed !== 'object') {
      throw new HttpException(
        { code: 'AI_SCHEMA_DRIFT', message: 'AI output missing root object' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    const p = parsed as Record<string, unknown>;
    const fieldsOk =
      typeof p.overallScore === 'number' &&
      typeof p.readinessLabel === 'string' &&
      ['พร้อมส่ง', 'ควรปรับปรุง', 'ต้องแก้ไขก่อนส่ง'].includes(
        p.readinessLabel as string,
      ) &&
      typeof p.rationale === 'string' &&
      typeof p.strongPoint === 'string' &&
      Array.isArray(p.suggestions);
    if (!fieldsOk) {
      throw new HttpException(
        {
          code: 'AI_SCHEMA_DRIFT',
          message: 'AI output failed schema validation',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (withCriteria && !Array.isArray(p.criteria)) {
      throw new HttpException(
        {
          code: 'AI_SCHEMA_DRIFT',
          message: 'AI output missing criteria array',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Merge deterministic hints with LLM verdicts. LLM row precedence:
   *   geo-auto / evidence-auto hint > LLM-only → hints win when present.
   * Unknown criterion id or verdict ⇒ 502 AI_SCHEMA_DRIFT.
   */
  private mergeCriteriaResults(
    entry: IssueRuleEntry,
    hints: CriterionHint[],
    llmRows: Array<{ criterionId: string; verdict: string; rationale: string }>,
  ): CriteriaEvaluationPayload {
    const allowedIds = new Set(entry.criteria.map((c) => c.id));
    const allowedVerdicts: CriterionVerdict[] = [
      'pass',
      'fail',
      'needs-evidence',
      'not-applicable',
    ];

    for (const row of llmRows) {
      if (!allowedIds.has(row.criterionId)) {
        throw new HttpException(
          {
            code: 'AI_SCHEMA_DRIFT',
            message: `Unknown criterion id: ${row.criterionId}`,
          },
          HttpStatus.BAD_GATEWAY,
        );
      }
      if (!allowedVerdicts.includes(row.verdict as CriterionVerdict)) {
        throw new HttpException(
          {
            code: 'AI_SCHEMA_DRIFT',
            message: `Unknown verdict: ${row.verdict}`,
          },
          HttpStatus.BAD_GATEWAY,
        );
      }
    }

    const hintIndex = new Map<string, CriterionHint>();
    for (const h of hints) hintIndex.set(h.criterionId, h);
    const llmIndex = new Map<string, (typeof llmRows)[number]>();
    for (const row of llmRows) llmIndex.set(row.criterionId, row);

    const results: CriterionResult[] = entry.criteria.map((c) => {
      const hint = hintIndex.get(c.id);
      const llm = llmIndex.get(c.id);
      if (hint) {
        const source: CriterionSource =
          hint.kind === 'geo-auto' ? 'geo-auto' : 'evidence-auto';
        return {
          criterionId: c.id,
          label: c.label,
          verdict: hint.suggestedVerdict,
          rationale: hint.reason,
          source,
        };
      }
      if (llm) {
        return {
          criterionId: c.id,
          label: c.label,
          verdict: llm.verdict as CriterionVerdict,
          rationale: llm.rationale,
          source: 'llm',
        };
      }
      return {
        criterionId: c.id,
        label: c.label,
        verdict: 'needs-evidence',
        rationale: '',
        source: 'llm',
      };
    });

    const hasFail = results.some((r) => r.verdict === 'fail');
    const hasNeeds = results.some((r) => r.verdict === 'needs-evidence');
    const overallAlignment: CriteriaEvaluationPayload['overallAlignment'] =
      hasFail ? 'misaligned' : hasNeeds ? 'partially-aligned' : 'aligned';

    return {
      rulesetVersion: entry.rulesetVersion,
      provinceCode: entry.provinceCode,
      issueKey: entry.issueKey,
      results,
      overallAlignment,
    };
  }

  /**
   * Simple criticality-weighted penalty: fails on high-criticality
   * criteria dock more from the overall score.
   *
   * Mirrors `AiService.computeCriticalityPenalty` so owner and staff
   * scoring stay comparable (intentional parity for the drift banner).
   */
  private computeCriticalityPenalty(
    entry: IssueRuleEntry,
    results: CriterionResult[],
  ): number {
    const indexed = new Map(entry.criteria.map((c) => [c.id, c]));
    let delta = 0;
    for (const r of results) {
      const meta = indexed.get(r.criterionId);
      if (!meta) continue;
      // Wave Evidence-Scope Decoupling (2026-05-22) — see
      // `AiService.computeCriticalityPenalty` for full rationale. Skip
      // score penalty for evidence-required criteria when the LLM
      // couldn't find evidence in prose (`fail` / `needs-evidence` from
      // an `llm` source). Deterministic auto-checks (`evidence-auto` /
      // `geo-auto`) retain their penalty because they are objective.
      if (
        meta.evidenceRequired === true &&
        (r.verdict === 'fail' || r.verdict === 'needs-evidence') &&
        r.source !== 'evidence-auto' &&
        r.source !== 'geo-auto'
      ) {
        continue;
      }
      if (r.verdict === 'fail') {
        delta -=
          meta.criticality === 'blocking'
            ? 10
            : meta.criticality === 'preferred'
              ? 5
              : 2;
      } else if (r.verdict === 'needs-evidence') {
        delta -=
          meta.criticality === 'blocking'
            ? 3
            : meta.criticality === 'preferred'
              ? 2
              : 1;
      }
    }
    return delta;
  }

  private async writeDetailLog(opts: {
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    inputTextLength: number;
    outputTextLength: number;
    costBaht: number;
    aiUsageQuotaId?: string;
    title?: string;
    dto: PreSubmitReviewDto;
    matchedRule: boolean;
    overallScore: number | null;
    readinessLabel: string | null;
    suggestionsCount: number;
    durationMs: number;
    error?: string;
  }): Promise<void> {
    try {
      await this.aiUsageLogsService.create({
        usageType: 'PRE_SUBMIT_REVIEW',
        modelName: opts.modelName,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        inputTextLength: opts.inputTextLength,
        outputTextLength: opts.outputTextLength,
        costBaht: opts.costBaht,
        aiUsageQuotaId: opts.aiUsageQuotaId,
        endpoint: 'staff-review/analyze',
        summaryTh: composeSummaryTh({
          endpoint: 'staff-review/analyze',
          title: opts.title,
        }),
        requestPayload: sanitizeRequestPayload({
          reportFormat: opts.dto.reportFormat,
          subTypeCode: opts.dto.subTypeCode,
          developmentIssueId: opts.dto.developmentIssueId,
          developmentIssueName: opts.dto.developmentIssueName,
          strategyName: opts.dto.strategyName,
          tacticName: opts.dto.tacticName,
          planName: opts.dto.planName,
          hasAttachments: Array.isArray(opts.dto.attachments)
            ? opts.dto.attachments.length
            : 0,
          titleLength:
            typeof opts.dto.project?.title === 'string'
              ? opts.dto.project.title.length
              : 0,
          additionalContext: opts.dto.additionalContext ?? '',
          objective: opts.dto.project?.objective ?? '',
        }),
        responsePayload: {
          overallScore: opts.overallScore,
          readinessLabel: opts.readinessLabel,
          suggestionsCount: opts.suggestionsCount,
          matchedRule: opts.matchedRule,
        },
        targetKind: 'none',
        durationMs: opts.durationMs,
        ...(opts.error ? { error: opts.error } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `[staff-review ai-usage-log] write failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /** Score-to-band helper (shared with envelope composer). */
  // Exposed for controller reuse.
  public scoreToBand = scoreToBand;
}
