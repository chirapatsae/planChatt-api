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
 *   [ROLE], [FORMAT], [ISSUE], [SUB_TYPES], [CRITERIA], [RULES], [OUTPUT]
 *
 * `[CRITERIA]` renders `{id} — {label} ({criticality})` per line with
 * the verbatim `description` OMITTED to save tokens.
 * `[SUB_TYPES]` renders `{code} {label}` per line.
 */
export function composeCriteriaContextBlock(rule: IssueRuleEntry): string {
  const subTypeLines = rule.subTypes
    .map((s) => `- ${s.code} ${s.label}`)
    .join('\n');

  const criteriaLines = rule.criteria
    .map((c) => `- ${c.id} — ${c.label} (${c.criticality})`)
    .join('\n');

  const characteristicsLines = rule.characteristics
    .map((c) => `- ${c}`)
    .join('\n');

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
    '[CRITERIA]',
    criteriaLines || '(ไม่มีหลักเกณฑ์)',
    '',
    '[RULES]',
    'กรุณาร่างเนื้อหาโครงการให้สอดคล้องกับประเด็นและหลักเกณฑ์ข้างต้น โดยเฉพาะเรื่องขอบเขตพื้นที่ ความคาบเกี่ยวระหว่าง อปท. และการหลีกเลี่ยงพื้นที่คุ้มครอง',
    'เนื้อหาต้องสะท้อน "ลักษณะโครงการที่สอดคล้อง" และไม่ขัดต่อหลักเกณฑ์ข้อใดข้อหนึ่ง',
    '',
    '[OUTPUT]',
    'เนื่องจากเป็น ISSUE_BASED reportFormat ห้ามส่งค่า indicator / strategyName / tacticName / planName ในผลลัพธ์ — ส่งเฉพาะ developmentIssueName หากจำเป็น',
    'ใช้หัวข้อไทยตามเทมเพลตที่ผู้ใช้กำหนด (ชื่อโครงการ / วัตถุประสงค์ / เป้าหมาย / ผลที่คาดว่าจะได้รับ) เท่านั้น',
  ].join('\n');
}
