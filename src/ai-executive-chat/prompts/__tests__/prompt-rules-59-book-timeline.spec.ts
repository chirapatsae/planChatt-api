/**
 * Wave AI-EXEC-CHAT-BOOK-TIMELINE-VIEW — prompt-rule spec for Rule #59
 * (book-timeline view: "ไทม์ไลน์เล่มแผน / ลำดับเล่ม" routes to a numbered
 * full-name book-lineage list composed from listActivePlans +
 * listDevelopmentPlanRevisions/Supplements `roundLabel`, with NO project /
 * count dump).
 *
 * Assertion style mirrors the sibling prompt-rule specs: token-presence
 * checks against the exported prompt string. Append-only guarantee: the
 * #58 anchor survives, #59 sits after it, and the Thai-only closing line
 * still terminates the prompt.
 */
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../executive-chat-system-prompt';

describe('book-timeline prompt rule #59', () => {
  it('rule #59 — routes book-timeline queries to a full-name lineage list, no project dump', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '59. ไทม์ไลน์เล่มแผน / ลำดับเล่ม',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1800);
    // Triggers.
    expect(tail).toContain('ไทม์ไลน์เล่มแผน');
    expect(tail).toContain('ลำดับเล่ม');
    // Uses the sub-book list tools + plan name; forbids project tools.
    expect(tail).toContain('listDevelopmentPlanRevisions');
    expect(tail).toContain('listDevelopmentPlanSupplements');
    expect(tail).toContain('listActivePlans');
    expect(tail).toContain('ห้าม');
    expect(tail).toContain('listProjectsInPlan');
    // Full-name label from the roundLabel envelope field, verbatim.
    expect(tail).toContain('roundLabel');
    expect(tail).toContain('{planName}');
    // Distinct from the per-project timeline (#34).
    expect(tail).toContain('กฎ #34');
    // Taxonomy order preserved (edit ≠ change).
    expect(tail).toContain('เล่มหลัก → เล่มแก้ไข → เล่มเปลี่ยนแปลง → เล่มเพิ่มเติม');
  });

  it('append-only — #58 anchor survives; #59 sits after it; Thai closing line terminates', () => {
    const idx58 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf('58. ');
    const idx59 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '59. ไทม์ไลน์เล่มแผน / ลำดับเล่ม',
    );
    expect(idx58).toBeGreaterThan(-1);
    expect(idx59).toBeGreaterThan(idx58);
    expect(
      EXECUTIVE_CHAT_SYSTEM_PROMPT.trimEnd().endsWith(
        'ทุกคำตอบตอบเป็นภาษาไทย เว้นแต่ผู้ใช้ถามเป็นภาษาอื่น',
      ),
    ).toBe(true);
  });
});
