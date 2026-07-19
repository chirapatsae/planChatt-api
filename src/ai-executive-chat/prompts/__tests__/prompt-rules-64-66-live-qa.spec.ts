/**
 * Wave AI-EXEC-CHAT-LIVE-QA-5BUG — prompt-rule spec for the three new
 * routing rules landed from the live QA sweep:
 *   - Rule #64 (BUG1): in-book count ("เล่ม X มีกี่ครุภัณฑ์/โครงการ") MUST
 *     use the DOCUMENT count; HEAD analytical tools are forbidden for it.
 *   - Rule #65 (BUG2): a type-specific book listing ("เล่มแก้ไข" vs
 *     "เล่มเปลี่ยนแปลง") MUST route via listDevelopmentPlanRevisions →
 *     listProjectsInRevisionBook / listEquipmentInRevisionBook; scope='revised'
 *     is forbidden because it merges both revision types.
 *   - Rule #66 (BUG5): cosmetic label render hygiene.
 *
 * Append-only guarantee: rule #63 anchor survives, #64/#65/#66 sit AFTER it,
 * and the Thai-only closing line still terminates the prompt.
 */
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../executive-chat-system-prompt';

describe('live-QA prompt rules #64 / #65 / #66', () => {
  it('rule #64 — in-book count uses DOCUMENT count; forbids HEAD analytical tools', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '64. จำนวนโครงการ/ครุภัณฑ์ "ในเล่มเดียว"',
    );
    expect(idx).toBeGreaterThan(-1);
    // Window widened (1600→2400) after rule #64 grew with English count triggers.
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 2400);
    expect(tail).toContain('เล่มหลักมีกี่ครุภัณฑ์');
    expect(tail).toContain('DOCUMENT count');
    // Document-count sources.
    expect(tail).toContain('getPlanCatalogOverview');
    expect(tail).toContain('listEquipmentInPlan');
    // Forbidden HEAD analytical tools.
    expect(tail).toContain('getEquipmentBudgetSummary');
    expect(tail).toContain('getEquipmentStatusBreakdown');
    // The ground-truth contradiction (HEAD=1 vs document=3).
    expect(tail).toContain('document = 3');
    // Count-consistency + concise (cross-ref #57).
    expect(tail).toContain('#57');
  });

  it('rule #65 — type-specific book listing never merges แก้ไข + เปลี่ยนแปลง', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '65. รายการ "ในเล่มแก้ไข" vs "ในเล่มเปลี่ยนแปลง"',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1600);
    // Correct routing chain.
    expect(tail).toContain('listDevelopmentPlanRevisions');
    expect(tail).toContain('listProjectsInRevisionBook');
    expect(tail).toContain('listEquipmentInRevisionBook');
    // Forbid the merged scope.
    expect(tail).toContain("listProjectsInPlan(scope='revised')");
    expect(tail).toContain('ห้ามเด็ดขาด');
    // แก้ไข ≠ เปลี่ยนแปลง.
    expect(tail).toContain('แก้ไข ≠ เปลี่ยนแปลง');
  });

  it('rule #66 — cosmetic label render hygiene (no doubled prefix, consistent spacing)', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '66. สุขอนามัยการ render label',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 900);
    expect(tail).toContain('โครงการ โครงการอบรม');
    expect(tail).toContain('ครั้งที่ 1/2569');
  });

  it('append-only — #63 anchor survives; #64/#65/#66 sit after it; Thai closing line terminates', () => {
    const idx63 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '63. การสืบทอด query-mode',
    );
    const idx64 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '64. จำนวนโครงการ/ครุภัณฑ์ "ในเล่มเดียว"',
    );
    const idx65 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '65. รายการ "ในเล่มแก้ไข" vs "ในเล่มเปลี่ยนแปลง"',
    );
    const idx66 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '66. สุขอนามัยการ render label',
    );
    expect(idx63).toBeGreaterThan(-1);
    expect(idx64).toBeGreaterThan(idx63);
    expect(idx65).toBeGreaterThan(idx64);
    expect(idx66).toBeGreaterThan(idx65);
    expect(
      EXECUTIVE_CHAT_SYSTEM_PROMPT.trimEnd().endsWith(
        'ทุกคำตอบตอบเป็นภาษาไทย เว้นแต่ผู้ใช้ถามเป็นภาษาอื่น',
      ),
    ).toBe(true);
  });
});
