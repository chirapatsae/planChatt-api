/**
 * Wave 24 N3 — criteria-aware prompt-block composer.
 *
 * Builds the Thai-language `[CRITERIA]` system-prompt segment consumed
 * by `AiService.generateProjectDetail` when (and ONLY when) the caller
 * is an ISSUE_BASED plan whose `developmentIssueId` resolves to a
 * registry entry in `IssueCriteriaRegistryService`.
 *
 * Source of truth:
 *   - docs/architecture/ISSUE_BASED_CRITERIA.md §6.1 (Generate prompt)
 *   - docs/architecture/ISSUE_BASED_CRITERIA.md §11 (ruleset versioning)
 *   - CLAUDE.md §17.2 advisory-only, §17.9 prompt-injection defense,
 *     §17.11 no role exemption
 *   - CLAUDE.md §16.5 classification shape — ISSUE_BASED payloads must
 *     NOT emit `indicator` / `strategyName` / `tacticName` / `planName`
 *
 * The output of this composer is SYSTEM-CONTROLLED text derived from
 * the in-repo registry. It contains NO user-supplied content and is
 * therefore safe to include as-is per §17.9 (user-supplied text lives
 * in a separate delimited block inside the user message).
 */

import { IssueRuleEntry } from './issue-criteria.types';

/**
 * Per the task spec (§7): sections in fixed order —
 *   [ROLE], [FORMAT], [ISSUE], [SUB_TYPES], [SUB_TYPE_SCOPE?], [CRITERIA],
 *   [RULES], [OUTPUT]
 *
 * `[CRITERIA]` renders `{id} — {label} ({criticality})` per line with
 * the verbatim `description` OMITTED to save tokens.
 * `[SUB_TYPES]` renders `{code} {label}` per line.
 *
 * Wave 28 N1 — anti-mix prompt tightening:
 *   - NEW `[SUB_TYPE_SCOPE]` section rendered ONLY when a sub-type can
 *     be resolved (see resolution order below).
 *   - NEW anti-mix directive appended to `[RULES]` (intentional
 *     redundancy — prompt hardening pattern; §17.9).
 *   - OUTPUT schema documentation extended to describe the OPTIONAL
 *     `rationaleRefs` metadata that the LLM MAY populate inside the
 *     existing Wave 13 opaque `categories` envelope. No new top-level
 *     DTO field; no new column; no migration.
 *
 * Sub-type resolution order (first match wins, else section omitted):
 *   1. explicit `opts.subTypeCode` hint matching an entry in `rule.subTypes`
 *   2. first exact-label match of `rule.subTypes[].label` inside
 *      `opts.userInputText` after NFC normalization + trim
 *   3. otherwise — omit the section entirely (legacy behavior)
 *
 * Compatibility: calling with no opts is byte-identical to pre-Wave-28
 * EXCEPT for the appended anti-mix bullet in `[RULES]`. The new
 * `[SUB_TYPE_SCOPE]` section is additive and opt-in via `opts`.
 */
export interface ComposeCriteriaContextOpts {
  /**
   * Explicit sub-type code hint from the caller (e.g. from a clicked
   * sub-type chip). Matched against `rule.subTypes[].code` verbatim.
   * Invalid / unmatched values are dropped silently (no throw) per §17.9.
   */
  subTypeCode?: string;
  /**
   * Optional user input text used for fallback label matching when
   * `subTypeCode` is not provided / not matched. NFC-normalized before
   * comparison. User-controlled — this composer does NOT echo the raw
   * text into the prompt; only the matched `IssueSubType` fields are
   * emitted (sourced from the in-repo registry), preserving §17.9.
   */
  userInputText?: string;
  /**
   * Wave 39 N2 — pre-composed `[EXAMPLES]` block from
   * `composeExamplesSection`. Passed in by the caller so the block is
   * positioned DETERMINISTICALLY between `[SUB_TYPE_SCOPE]` and
   * `[CRITERIA]` inside the composed system-prompt string. Empty string
   * (or omitted) produces no `[EXAMPLES]` section — byte-identical to
   * pre-Wave-39 output for callers that don't opt in.
   *
   * The caller is responsible for resolving the same `subTypeCode` used
   * for `[SUB_TYPE_SCOPE]` resolution so the two sections stay aligned.
   * Static system content per §17.9 — MUST NOT contain user prose.
   */
  examplesBlock?: string;
  /**
   * 2026-05-22 — format-aware `[OUTPUT]` block. Defaults to `ISSUE_BASED`
   * so all existing ISSUE_BASED callers stay byte-identical. When the
   * STRATEGY_BASED multi-entry composer delegates to this single-entry
   * function (N=1 case OR per-entry in N>1), it MUST pass
   * `'STRATEGY_BASED'` so the `[OUTPUT]` directive:
   *   - drops the ISSUE_BASED-specific "ห้ามส่งค่า indicator" clause
   *     (STRATEGY_BASED projects REQUIRE indicator per §16.5 shape)
   *   - expands the canonical heading list to include `งบประมาณ` and
   *     `ตัวชี้วัด` so the LLM does NOT suppress those sections under
   *     the strict `เท่านั้น` rule (previously caused empty budget cards
   *     for LAO + STRATEGY_BASED — confirmed by user 2026-05-22)
   *   - emits the correct format label in the opening sentence
   */
  format?: 'ISSUE_BASED' | 'STRATEGY_BASED';
}

function resolveSubType(
  rule: IssueRuleEntry,
  opts?: ComposeCriteriaContextOpts,
): { code: string; label: string } | null {
  if (!opts || rule.subTypes.length === 0) return null;
  // Priority 1: explicit code hint.
  if (opts.subTypeCode) {
    const byCode = rule.subTypes.find((s) => s.code === opts.subTypeCode);
    if (byCode) return { code: byCode.code, label: byCode.label };
  }
  // Priority 2: first exact-label match inside user input text (NFC).
  if (opts.userInputText) {
    const normalizedText = opts.userInputText.normalize('NFC').trim();
    if (normalizedText.length > 0) {
      for (const s of rule.subTypes) {
        const normalizedLabel = s.label.normalize('NFC').trim();
        if (normalizedLabel.length === 0) continue;
        if (normalizedText.includes(normalizedLabel)) {
          return { code: s.code, label: s.label };
        }
      }
    }
  }
  return null;
}

export function composeCriteriaContextBlock(
  rule: IssueRuleEntry,
  opts?: ComposeCriteriaContextOpts,
): string {
  const subTypeLines = rule.subTypes
    .map((s) => `- ${s.code} ${s.label}`)
    .join('\n');

  // Wave AI-Enforcement-Model (2026-05-22) — only show LLM-PROSE
  // criteria to the LLM. The auto-pass / auto-check / staff-only modes
  // are resolved deterministically by the AI service AFTER the LLM
  // call, so listing them in the [CRITERIA] section would just waste
  // tokens AND tempt the LLM to mis-judge things that are out of its
  // domain (engineering standards, regulation, system-implicit). The
  // merger's missing-coverage check is also restricted to llm-prose
  // ids to match — see ai.service.ts mergeCriteriaResults.
  const criteriaLines = rule.criteria
    .filter((c) => c.enforcement === 'llm-prose')
    .map((c) => `- ${c.id} — ${c.label} (${c.criticality})`)
    .join('\n');

  const characteristicsLines = rule.characteristics
    .map((c) => `- ${c}`)
    .join('\n');

  const resolvedSubType = resolveSubType(rule, opts);

  // Wave 28 N1 — anti-mix + SUB_TYPE_SCOPE directives (Thai, verbatim).
  const subTypeScopeBlock = resolvedSubType
    ? [
        '[SUB_TYPE_SCOPE]',
        `ผู้ใช้เลือกประเภทย่อย: "${resolvedSubType.label}" (code: ${resolvedSubType.code})`,
        'โครงการนี้ต้องมุ่งเฉพาะประเด็นของประเภทย่อยนี้เท่านั้น',
        'ห้ามนำเรื่องอื่นภายใต้ประเด็นเดียวกันมาปะปน',
        '',
      ]
    : [];

  // Wave 39 N2 — optional `[EXAMPLES]` block positioned AFTER
  // `[SUB_TYPE_SCOPE]` and BEFORE `[CRITERIA]`. Caller pre-composes via
  // `composeExamplesSection` and passes the string through
  // `opts.examplesBlock`. Empty / missing → no emission.
  const examplesLines =
    opts?.examplesBlock && opts.examplesBlock.length > 0
      ? [opts.examplesBlock, '']
      : [];

  // Lines are concatenated without trailing blank lines inside each
  // section to keep the prompt compact; a single blank line separates
  // sections so the LLM parses them as distinct blocks.
  // Single-อปท: the [ROLE] line is intentionally DROPPED here — the system
  // prompt already sets the municipal analyst persona (MUNICIPAL_PROFILE).
  // Re-stating a provincial ("จังหวัดนครราชสีมา") role here previously
  // overrode that identity and leaked อบจ./จังหวัด framing into every draft.
  return [
    '[FORMAT]',
    'รายงานนี้เป็น ISSUE_BASED (ประเด็นการพัฒนา) — ห้ามใช้ฟิลด์ ยุทธศาสตร์/กลยุทธ์/แผนงาน/ตัวชี้วัด',
    '',
    '[ISSUE]',
    `ประเด็น: ${rule.issueDisplayName}`,
    `รหัสประเด็น (issueKey): ${rule.issueKey}`,
    `เวอร์ชันเกณฑ์ (rulesetVersion): ${rule.rulesetVersion}`,
    characteristicsLines
      ? `ลักษณะโครงการที่สอดคล้อง:\n${characteristicsLines}`
      : 'ลักษณะโครงการที่สอดคล้อง: (ไม่มีข้อมูลเฉพาะ)',
    '',
    '[SUB_TYPES]',
    subTypeLines || '(ไม่มีประเภทย่อย)',
    '',
    ...subTypeScopeBlock,
    ...examplesLines,
    '[CRITERIA]',
    criteriaLines || '(ไม่มีหลักเกณฑ์)',
    '',
    '[RULES]',
    'กรุณาร่างเนื้อหาโครงการให้สอดคล้องกับประเด็นและหลักเกณฑ์ข้างต้น โดยเฉพาะเรื่องขอบเขตพื้นที่ต้องอยู่ในเขตเทศบาลตำบลหนองกระทุ่ม อยู่ในอำนาจหน้าที่ของเทศบาล และการหลีกเลี่ยงพื้นที่คุ้มครอง',
    'เนื้อหาต้องสะท้อน "ลักษณะโครงการที่สอดคล้อง" และไม่ขัดต่อหลักเกณฑ์ข้อใดข้อหนึ่ง',
    // Wave 28 N1 — intentional redundancy with [SUB_TYPE_SCOPE] to harden
    // the prompt against topic drift across sub-types under the same issue.
    'ห้ามนำเรื่องอื่นภายใต้ประเด็นเดียวกันมาปะปน — ยึดเฉพาะประเภทย่อยที่ระบุใน [SUB_TYPE_SCOPE] หากมี',
    '',
    // Wave LAO-STRATEGY-AI-PARITY Followup G+R Coherence (2026-05-22) —
    // [CRITERIA_OUTPUT_REQUIREMENTS] block.
    //
    // BACKGROUND: Before this block, the LLM saw [CRITERIA] as "context
    // it knows about" but had no explicit instruction to ADDRESS each
    // criterion in the generated content. The downstream pre-submit-
    // review then scored the same project against the same criteria and
    // found gaps (e.g. "ระบุชื่อระบบที่ใช้", "ระบุแหล่งข้อมูลอ้างอิง"),
    // producing low scores (production observation 2026-05-22: 59/100
    // with 2 high-priority "จำเป็น" suggestions for content that the
    // Generator never knew it had to provide).
    //
    // FIX: Tell the Generator EXPLICITLY that the same [CRITERIA] list
    // will be used downstream to score the project, and require it to
    // produce concrete content addressing each criterion. When the user
    // hasn't supplied a specific value, the Generator inserts a clearly-
    // marked example with the "(ตัวอย่างจาก AI — โปรดยืนยัน)" tag so
    // the user knows where to confirm/edit.
    //
    // §17.2 advisory — this changes generation quality, not workflow
    // gating. §17.9 — static system content sourced from in-repo
    // registry; no user prose enters the block. The "(ตัวอย่างจาก AI —
    // โปรดยืนยัน)" tag is a presentational convention that the Reviewer
    // recognizes as concrete content (not as missing data).
    '[CRITERIA_OUTPUT_REQUIREMENTS]',
    'หลักเกณฑ์ใน [CRITERIA] ข้างต้นจะถูกนำไปใช้ตรวจสอบโครงการในขั้นตอนถัดไป — เนื้อหาที่สร้างต้องตอบหลักเกณฑ์ทุกข้ออย่างเฉพาะเจาะจง ดังนี้:',
    '1. ห้ามใช้ข้อความทั่วไป — ต้องระบุ "ทำอย่างไร / ที่ไหน / กี่คน / ด้วยอะไร / วัดอย่างไร" ที่เฉพาะเจาะจง',
    '   ตัวอย่างที่ไม่ดี: "นำเทคโนโลยีสมัยใหม่มาใช้" → ตัวอย่างที่ดี: "ติดตั้งระบบน้ำหยดอัตโนมัติแบบ IoT จากบริษัท X ในพื้นที่ 200 ไร่"',
    '2. ทุกตัวชี้วัด (output / outcome) ต้องระบุแหล่งข้อมูลอ้างอิงโดยใส่ชื่อหน่วยงาน / ปีของข้อมูล',
    '   ตัวอย่างที่ดี: "วัดผลจากสำมะโนเกษตรกร กรมส่งเสริมการเกษตร 2568 และการสำรวจรายได้ครัวเรือนของเทศบาลตำบล X"',
    '3. หากผู้ใช้ไม่ได้ระบุข้อมูลเฉพาะ (เช่น ชื่อระบบ ชื่อเทคโนโลยี ชื่อแหล่งอ้างอิง) ให้ใส่ค่าตัวอย่างที่เหมาะกับบริบทพื้นที่ พร้อมต่อท้ายในวงเล็บว่า "(ตัวอย่างจาก AI — โปรดยืนยัน)"',
    '4. ห้ามใช้คำว่า "เช่น" หรือ "เป็นต้น" ลอย ๆ โดยไม่มีตัวอย่างจริงต่อท้าย',
    '5. ห้ามตอบว่า "จะกำหนดภายหลัง" หรือ "อยู่ระหว่างการศึกษา" — ต้องระบุค่าที่เป็นไปได้พร้อมแท็ก "(ตัวอย่างจาก AI — โปรดยืนยัน)"',
    // Wave Evidence-Scope Decoupling (2026-05-22) — separation of concerns:
    // AI ไม่ตรวจเอกสารแนบ → Generator ไม่ต้องเขียน prose เกี่ยวกับเอกสาร
    // เจ้าหน้าที่จะตรวจเอกสารจริงในขั้นตอน review แยกต่างหาก
    '6. หลักเกณฑ์ที่ต้องการ "หลักฐาน / เอกสารแนบ / ใบอนุญาต / ใบรับรอง / รูปถ่าย" — ไม่ต้องเขียนถึงในเนื้อหา prose ระบบจะตรวจสอบจากไฟล์แนบของผู้ใช้แยกต่างหากในขั้นตอน review โดยเจ้าหน้าที่ — Generator มีหน้าที่สร้างเนื้อหา prose เท่านั้น ไม่มีหน้าที่กำกับการแนบเอกสาร',
    'หลักเกณฑ์ที่ criticality = "blocking" และไม่ใช่หลักเกณฑ์เรื่องเอกสารแนบ ต้องระบุรายละเอียดเฉพาะเจาะจงเป็นพิเศษ — หากขาดจะทำให้ขั้นตอนการตรวจสอบให้คะแนนต่ำ',
    'เป้าหมายของผลลัพธ์: ผู้ใช้สามารถนำข้อความที่สร้างไปใช้ได้ทันที โดยแก้ไขเฉพาะค่าที่มีแท็ก "(ตัวอย่างจาก AI — โปรดยืนยัน)"',
    '',
    '[OUTPUT]',
    // 2026-05-22 — format-aware output directive.
    //   ISSUE_BASED: must NOT emit indicator/strategy/tactic/plan (§16.5
    //     shape: only developmentIssueId is required). The 4-section
    //     `เท่านั้น` whitelist is safe because งบประมาณ is a primary
    //     form field handled by the controller-side parser separately
    //     and historically WAS still emitted; if the LLM drops it, the
    //     FE budget card just won't render (acceptable for ISSUE_BASED
    //     as the budget feature predates the criteria block).
    //   STRATEGY_BASED: indicator IS required (§16.5), and the
    //     `เท่านั้น` whitelist previously caused the LLM to suppress
    //     งบประมาณ + ตัวชี้วัด, breaking the budget card and indicator
    //     auto-fill for LAO users on STRATEGY_BASED plans. The
    //     expanded list below includes both.
    ((opts?.format ?? 'ISSUE_BASED') === 'STRATEGY_BASED'
      ? 'เนื่องจากเป็น STRATEGY_BASED reportFormat ต้องส่งค่า indicator / strategyName / tacticName / planName ตามที่ผู้ใช้เลือก — ห้ามส่งค่า developmentIssueName'
      : 'เนื่องจากเป็น ISSUE_BASED reportFormat ห้ามส่งค่า indicator / strategyName / tacticName / planName ในผลลัพธ์ — ส่งเฉพาะ developmentIssueName หากจำเป็น'),
    ((opts?.format ?? 'ISSUE_BASED') === 'STRATEGY_BASED'
      ? 'ใช้หัวข้อไทยตามเทมเพลตที่ผู้ใช้กำหนด (ชื่อโครงการ / วัตถุประสงค์ / เป้าหมาย / ผลที่คาดว่าจะได้รับ / ตัวชี้วัด / งบประมาณ) เท่านั้น'
      : 'ใช้หัวข้อไทยตามเทมเพลตที่ผู้ใช้กำหนด (ชื่อโครงการ / วัตถุประสงค์ / เป้าหมาย / ผลที่คาดว่าจะได้รับ / งบประมาณ) เท่านั้น'),
    // Wave 28 N1 — optional rationaleRefs metadata. Rides inside the
    // existing Wave 13 opaque `categories` bag; the LLM MAY populate it
    // to aid FE highlighting but MUST NOT treat it as required. Missing
    // field is a valid payload (schema validation marks it optional).
    'คุณสามารถแนบฟิลด์ "rationaleRefs" (object) เพิ่มเติมในผลลัพธ์ได้ (ไม่บังคับ) เพื่ออ้างอิงบริบทที่ใช้ประเมิน โดยมีรูปแบบดังนี้: { "issueKey"?: string, "subTypeCode"?: string, "criterionIds"?: string[] } — ฟิลด์ทั้งหมดเป็น optional และไม่ส่งผลต่อผลการตัดสินของเจ้าหน้าที่ (advisory metadata)',
  ].join('\n');
}

/**
 * Wave 39 N2 — assemble the `[EXAMPLES]` prompt block.
 *
 * Emits concrete activity templates for the resolved sub-type (from
 * Wave 24 registry / Wave 39 N1 seeding) as "วัตถุดิบทางเลือก" for LLM
 * drafting. The block is positioned BETWEEN `[SUB_TYPE_SCOPE]` and
 * `[CRITERIA]` inside `composeCriteriaContextBlock` — callers pass the
 * returned string via `opts.examplesBlock`.
 *
 * Returns empty string (graceful fallback) when ANY of:
 *   - `rule` is null
 *   - `subTypeCode` is null / undefined / empty
 *   - the resolved sub-type does not exist in `rule.subTypes`
 *   - the sub-type has no `exampleActivities` (or the array is empty)
 *
 * §17.2 advisory — LLM treats entries as OPTIONAL inspiration, never
 * mandatory copy-paste targets. §17.9 static system content sourced
 * from in-repo registry; NO user prose enters this block.
 */
export function composeExamplesSection(
  rule: IssueRuleEntry | null,
  subTypeCode: string | null | undefined,
): string {
  if (!rule || !subTypeCode) return '';
  const subType = rule.subTypes.find((s) => s.code === subTypeCode);
  if (!subType) return '';
  const activities = subType.exampleActivities ?? [];
  if (activities.length === 0) return '';

  const lines: string[] = [];
  lines.push('[EXAMPLES]');
  lines.push(
    `ตัวอย่างกิจกรรมที่เป็นไปได้สำหรับประเภทย่อย "${subType.label}":`,
  );
  for (const a of activities) {
    lines.push(`- ${a}`);
  }
  lines.push('');
  lines.push('ให้ใช้ตัวอย่างเหล่านี้เป็น "วัตถุดิบทางเลือก" ในการเขียน');
  lines.push('อาจเลือกบางข้อ ปรับรายละเอียด หรือเสนอกิจกรรมที่คล้ายกัน');
  lines.push(
    'แต่ทุกกิจกรรมที่ใช้ต้องมีรายละเอียด: ชื่อกิจกรรม · สถานที่/กลุ่มเป้าหมาย · ความถี่หรือระยะเวลา · ตัวเลขที่คาดการณ์',
  );
  lines.push('[END_EXAMPLES]');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Wave LAO_STRATEGY_AI_PARITY — Node N1
//
// Multi-entry criteria context composer.
//
// Companion to `composeCriteriaContextBlock` (single-entry). The
// existing single-entry composer is UNCHANGED (byte-for-byte) so the
// pre-Wave ISSUE_BASED generate / pre-submit-review paths keep their
// regression baseline.
//
// This sibling composer accepts an array of `IssueRuleEntry`s — the
// STRATEGY_BASED → multi-issue case — and emits a single prompt-ready
// system block with:
//   - N=0 → '' (caller skips block entirely; no header emitted)
//   - N=1 → byte-identical to the single-entry composer for that entry
//           (the format/issueName/strategyName labels in `opts` are
//           IGNORED for N=1 so the regression baseline is preserved)
//   - N>1 → one composed `[CRITERIA]` / `[EXAMPLES]` / `[CONSTRAINTS]`
//           sub-block per entry, joined by a deterministic
//           `[ISSUE_BOUNDARY]` delimiter, with a STRATEGY_BASED top-
//           level `[FORMAT]` header carrying strategyName + matched
//           count.
//
// Output is static system content sourced from the in-repo registry —
// §17.9 prompt-injection discipline preserved (no user prose enters
// the block; issueName / strategyName labels passed via `opts` are
// caller-supplied label strings, not user-supplied free text — the
// caller is responsible for sourcing them from the plan / strategy
// table rather than echoing user input).
//
// Each per-entry sub-block carries the entry's `issueKey` in its
// `[ISSUE]` header so the downstream merger + snapshot writer can
// disambiguate per-issue verdict rows.
// ---------------------------------------------------------------------------

/**
 * Top-level format discriminator routed to the prompt header.
 * Mirrors `DevelopmentPlan.reportFormat` (§16.2) — values are FROZEN.
 */
export type CriteriaPromptFormat = 'STRATEGY_BASED' | 'ISSUE_BASED';

export interface ComposeMultiEntryOpts {
  /** Plan-level format discriminator. Drives the top header for N>1. */
  format: CriteriaPromptFormat;
  /**
   * Ruleset version stamp from the registry. Carried for snapshot
   * traceability (§17.4). Per-entry rulesetVersion is also emitted
   * inside each `[ISSUE]` sub-block, so this top-level value is
   * INFORMATIONAL only — included in the header for STRATEGY_BASED
   * N>1 so reviewers can confirm version-pinning at a glance.
   */
  rulesetVersion: string;
  /**
   * Strategy display name (STRATEGY_BASED only). Caller MUST source
   * from the strategy table — never from user prose (§17.9).
   */
  strategyName?: string;
  /**
   * Issue display name (ISSUE_BASED only). Caller MUST source from
   * the development_issue table — never from user prose (§17.9).
   * IGNORED when N=1 because the single-entry composer already emits
   * `issueDisplayName` inside `[ISSUE]`.
   */
  issueName?: string;
}

/**
 * Deterministic boundary marker between per-entry sub-blocks. Picked
 * to match the existing `[ISSUE]` / `[CRITERIA]` bracket convention so
 * the LLM treats it as a section header rather than free prose.
 */
const ISSUE_BOUNDARY = '\n\n--- [ISSUE_BOUNDARY] ---\n\n';

export function composeMultiEntryCriteriaContextBlock(
  entries: IssueRuleEntry[],
  opts: ComposeMultiEntryOpts,
): string {
  // N=0 — caller skips block entirely. No header is emitted because
  // there is nothing for the LLM to act on; emitting a header alone
  // would be misleading prompt content.
  if (entries.length === 0) return '';

  // N=1 — regression baseline for ISSUE_BASED (byte-identical to
  // pre-Wave single-entry composer output). For STRATEGY_BASED, the
  // `[OUTPUT]` block must adapt (per 2026-05-22 fix): single-entry
  // composer now accepts `opts.format` and switches the directive
  // accordingly. ISSUE_BASED callers that omit `format` continue to
  // get the unchanged ISSUE_BASED [OUTPUT] block (byte-identity).
  if (entries.length === 1) {
    return composeCriteriaContextBlock(entries[0], { format: opts.format });
  }

  // N>1 — STRATEGY_BASED multi-issue composition. ISSUE_BASED with
  // N>1 is not a defined input (one project has exactly one
  // developmentIssue per §16.5), so we still render defensively under
  // the STRATEGY header but document the case here for future review.
  const strategyLabel = opts.strategyName ?? '(ไม่ระบุชื่อยุทธศาสตร์)';
  const formatHeader =
    opts.format === 'STRATEGY_BASED'
      ? [
          '[FORMAT]',
          `รายงานนี้เป็น STRATEGY_BASED (ยุทธศาสตร์) — ผู้ใช้ระบุยุทธศาสตร์ "${strategyLabel}" ที่ครอบคลุม ${entries.length} ประเด็นการพัฒนา (rulesetVersion: ${opts.rulesetVersion})`,
          'พิจารณาทุกประเด็นด้านล่างประกอบกัน โดยแต่ละประเด็นมีหลักเกณฑ์เฉพาะของตนเอง — ห้ามนำหลักเกณฑ์จากประเด็นหนึ่งมาทดแทนอีกประเด็นหนึ่ง',
          '',
        ].join('\n')
      : [
          '[FORMAT]',
          `รายงานนี้เป็น ISSUE_BASED (ประเด็นการพัฒนา) — มี ${entries.length} ประเด็นที่เกี่ยวข้อง (rulesetVersion: ${opts.rulesetVersion})`,
          'ห้ามใช้ฟิลด์ ยุทธศาสตร์/กลยุทธ์/แผนงาน/ตัวชี้วัด',
          '',
        ].join('\n');

  // One full single-entry block per entry. Each block already carries
  // its own `[ISSUE]` header with `issueKey`, satisfying the
  // disambiguation requirement. Format is forwarded so each per-entry
  // `[OUTPUT]` directive reflects the parent envelope's format (avoids
  // the "indicator/budget suppressed" trap for STRATEGY_BASED N>1).
  const perEntryBlocks = entries.map((e) =>
    composeCriteriaContextBlock(e, { format: opts.format }),
  );

  return [formatHeader, perEntryBlocks.join(ISSUE_BOUNDARY)].join('\n');
}
