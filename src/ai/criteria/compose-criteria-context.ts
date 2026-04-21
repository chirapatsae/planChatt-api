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

  const criteriaLines = rule.criteria
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
  return [
    '[ROLE]',
    'คุณเป็นผู้เชี่ยวชาญด้านการวางแผนพัฒนาท้องถิ่น จังหวัดนครราชสีมา ที่ต้องร่างโครงการให้สอดคล้องกับประเด็นและหลักเกณฑ์ของจังหวัดอย่างเคร่งครัด',
    '',
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
    'กรุณาร่างเนื้อหาโครงการให้สอดคล้องกับประเด็นและหลักเกณฑ์ข้างต้น โดยเฉพาะเรื่องขอบเขตพื้นที่ ความคาบเกี่ยวระหว่าง อปท. และการหลีกเลี่ยงพื้นที่คุ้มครอง',
    'เนื้อหาต้องสะท้อน "ลักษณะโครงการที่สอดคล้อง" และไม่ขัดต่อหลักเกณฑ์ข้อใดข้อหนึ่ง',
    // Wave 28 N1 — intentional redundancy with [SUB_TYPE_SCOPE] to harden
    // the prompt against topic drift across sub-types under the same issue.
    'ห้ามนำเรื่องอื่นภายใต้ประเด็นเดียวกันมาปะปน — ยึดเฉพาะประเภทย่อยที่ระบุใน [SUB_TYPE_SCOPE] หากมี',
    '',
    '[OUTPUT]',
    'เนื่องจากเป็น ISSUE_BASED reportFormat ห้ามส่งค่า indicator / strategyName / tacticName / planName ในผลลัพธ์ — ส่งเฉพาะ developmentIssueName หากจำเป็น',
    'ใช้หัวข้อไทยตามเทมเพลตที่ผู้ใช้กำหนด (ชื่อโครงการ / วัตถุประสงค์ / เป้าหมาย / ผลที่คาดว่าจะได้รับ) เท่านั้น',
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
