/**
 * Wave AI-EXEC-CHAT-FOLLOWUP-SCOPE-AND-COUNT-INTENT — prompt-rule spec for
 * Rule #56 (follow-up scope-carry — subjectless project/budget/status
 * follow-up inherits the prior plan/book scope; plan-level context
 * defaults to scope=main) and Rule #57 (count-intent vs list-intent —
 * "กี่/จำนวน" answers count-only, no per-project dump).
 *
 * Assertion style mirrors `prompt-rules-54-scope.spec.ts`: token-presence
 * checks against the exported prompt string. Append-only guarantee: rules
 * #1–#55 anchors survive; #56/#57 sit AFTER #55 and the Thai-only closing
 * line still terminates the prompt.
 */
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../executive-chat-system-prompt';

describe('follow-up prompt rules #56 / #57', () => {
  it('rule #56 — subjectless follow-up inherits prior plan/book scope (default main)', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '56. การสืบทอด scope ในคำถามต่อเนื่อง',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 2000);
    // Subjectless follow-up triggers.
    expect(tail).toContain('มีกี่โครงการ');
    // Default scope = main for plan-level context (D1).
    expect(tail).toContain("scope='main'");
    expect(tail).toContain('เล่มหลัก');
    // Must NOT silently default to all.
    expect(tail).toContain("scope='all'");
    // Echo the inherited scope.
    expect(tail).toContain('echo scope');
    // Sub-book inheritance path.
    expect(tail).toContain('revisionId/supplementId');
    // Override phrase for the all-books case.
    expect(tail).toContain('รวมทุกเล่ม');
    // Ambiguous → ask back, never guess all.
    expect(tail).toContain('ถามกลับ');
    // Cross-references.
    expect(tail).toContain('กฎ #42');
    expect(tail).toContain('กฎ #44');
    expect(tail).toContain('กฎ #54');
  });

  it('rule #57 — count-intent answers count-only; list-intent shows full list', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '57. คำถามนับจำนวน vs คำถามขอรายการ',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1600);
    expect(tail).toContain('count-intent');
    expect(tail).toContain('list-intent');
    // Count-only forbids per-project dump.
    expect(tail).toContain('ห้าม dump รายละเอียดโครงการรายตัว');
    // List-intent triggers.
    expect(tail).toContain('มีอะไรบ้าง');
    expect(tail).toContain('รายละเอียด');
    // Mixed intent → list wins.
    expect(tail).toContain('list-intent ชนะ');
    // Cross-ref count-first rule.
    expect(tail).toContain('กฎ #41');
    // Cross-ref scope-carry for the "then give detail" follow-up.
    expect(tail).toContain('กฎ #56');
  });

  it('rule #58 — identification / single-fact answers stay minimal (no unsolicited metadata)', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '58. คำถามระบุตัว/ค้นหาข้อเท็จจริงเดียว',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 900);
    expect(tail).toContain('คือเล่มไหน');
    // Must forbid padding the answer with freshness / activity / format meta.
    expect(tail).toContain('ห้ามพ่วง metadata');
    expect(tail).toContain('freshnessLabel');
    expect(tail).toContain('activities');
  });

  it('append-only — rule #55 anchor survives; #56/#57/#58 sit after it; Thai closing line terminates', () => {
    const idx55 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf('55. นิยามการนับ');
    const idx56 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '56. การสืบทอด scope ในคำถามต่อเนื่อง',
    );
    const idx57 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '57. คำถามนับจำนวน vs คำถามขอรายการ',
    );
    const idx58 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '58. คำถามระบุตัว/ค้นหาข้อเท็จจริงเดียว',
    );
    expect(idx55).toBeGreaterThan(-1);
    expect(idx56).toBeGreaterThan(idx55);
    expect(idx57).toBeGreaterThan(idx56);
    expect(idx58).toBeGreaterThan(idx57);
    expect(
      EXECUTIVE_CHAT_SYSTEM_PROMPT.trimEnd().endsWith(
        'ทุกคำตอบตอบเป็นภาษาไทย เว้นแต่ผู้ใช้ถามเป็นภาษาอื่น',
      ),
    ).toBe(true);
  });
});
