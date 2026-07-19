/**
 * Wave AI-EXEC-CHAT-QUERY-MODE-CARRY — prompt-rule spec for Rule #63:
 * a subjectless follow-up that only swaps the subject (โครงการ ↔ ครุภัณฑ์)
 * inherits the PRIOR query-mode (head-roster / document-list / count /
 * budget / status) applied to the new subject.
 *
 * Append-only: #62 anchor survives, #63 after it, Thai closing line still
 * terminates the prompt.
 */
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../executive-chat-system-prompt';

describe('query-mode carry prompt rule #63', () => {
  it('rule #63 — mode-carry: head-roster + "ครุภัณฑ์ละ" → listEquipmentHeadRoster, not listEquipmentInPlan', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '63. การสืบทอด query-mode',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 2000);
    // Trigger words.
    expect(tail).toContain('ครุภัณฑ์ละ');
    expect(tail).toContain('โครงการละ');
    // Head-roster carry mapping (the reported regression).
    expect(tail).toContain('listEquipmentHeadRoster');
    expect(tail).toContain('listProjectHeadRoster');
    // Explicit forbid of the document-dump reset.
    expect(tail).toContain('ห้าม');
    expect(tail).toContain('listEquipmentInPlan');
    // Carries mode + scope; new explicit mode wins.
    expect(tail).toContain('query-mode + scope');
    // Cross-references.
    expect(tail).toContain('#56');
    expect(tail).toContain('#57');
    expect(tail).toContain('#61/#62');
  });

  it('append-only — #62 anchor survives; #63 after it; Thai closing line terminates', () => {
    const idx62 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '62. โครงการล่าสุด (HEAD) ทุกอันในแผน',
    );
    const idx63 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf('63. การสืบทอด query-mode');
    expect(idx62).toBeGreaterThan(-1);
    expect(idx63).toBeGreaterThan(idx62);
    expect(
      EXECUTIVE_CHAT_SYSTEM_PROMPT.trimEnd().endsWith(
        'ทุกคำตอบตอบเป็นภาษาไทย เว้นแต่ผู้ใช้ถามเป็นภาษาอื่น',
      ),
    ).toBe(true);
  });
});
