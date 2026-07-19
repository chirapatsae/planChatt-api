/**
 * Wave AI-EXEC-CHAT-HEAD-BOOK-ROSTER-AND-VERBOSE-OMIT (rework) — prompt-rule
 * spec for Rule #61 (origin-book → head-book roster) and Rule #62 (plan HEAD
 * roster), both now MANDATING the dedicated `listProjectHeadRoster` tool
 * (the prompt-chain loop / byRevisionRound routing failed live E2E).
 *
 * Append-only: #60 anchor survives, #61/#62 after it, Thai closing line
 * still terminates the prompt.
 */
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../executive-chat-system-prompt';

describe('head-book roster prompt rules #61 / #62 (tool-based rework)', () => {
  it('rule #61 — origin-book roster via listProjectHeadRoster(originScope); forbids listProjectsInPlan', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '61. เล่มล่าสุดของทุกโครงการในเล่ม X',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1500);
    // Mandated tool + scope.
    expect(tail).toContain('listProjectHeadRoster');
    expect(tail).toContain("originScope='main'");
    // Envelope fields for the render.
    expect(tail).toContain('headBookLabel');
    expect(tail).toContain('headPageNumber');
    expect(tail).toContain('headStatusTh');
    // Hard forbid of the wrong tools (✗ examples).
    expect(tail).toContain('ห้ามใช้ listProjectsInPlan');
    expect(tail).toContain('getProjectHeadBook');
    expect(tail).toContain('ใช้ roster tool เดียวแทน');
    // De-conflict + no verbose.
    expect(tail).toContain('กฎ #33');
    expect(tail).toContain('กฎ #59');
    expect(tail).toContain('ไม่ verbose');
  });

  it('rule #62 — plan HEAD roster via listProjectHeadRoster (no originScope); forbids listProjectsInPlan', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '62. โครงการล่าสุด (HEAD) ทุกอันในแผน',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1200);
    expect(tail).toContain('listProjectHeadRoster(planId)');
    expect(tail).toContain('ไม่ส่ง originScope');
    expect(tail).toContain('ห้ามใช้');
    // Regression evidence baked into the rule.
    expect(tail).toContain('พบ 1 โครงการ');
    expect(tail).toContain('กฎ #61');
    expect(tail).toContain('ไม่ verbose');
  });

  it('append-only — #60 anchor survives; #61/#62 after it; Thai closing line terminates', () => {
    const idx60 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '60. ระดับรายละเอียดของการ list',
    );
    const idx61 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '61. เล่มล่าสุดของทุกโครงการในเล่ม X',
    );
    const idx62 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '62. โครงการล่าสุด (HEAD) ทุกอันในแผน',
    );
    expect(idx60).toBeGreaterThan(-1);
    expect(idx61).toBeGreaterThan(idx60);
    expect(idx62).toBeGreaterThan(idx61);
    expect(
      EXECUTIVE_CHAT_SYSTEM_PROMPT.trimEnd().endsWith(
        'ทุกคำตอบตอบเป็นภาษาไทย เว้นแต่ผู้ใช้ถามเป็นภาษาอื่น',
      ),
    ).toBe(true);
  });
});
