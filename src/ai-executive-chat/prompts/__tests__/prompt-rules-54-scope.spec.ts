/**
 * Wave AI-EXEC-CHAT-BOOK-ANSWER-QUALITY — prompt-rule spec for the
 * answer-scope-discipline rules #54 (HARD 3-domain gate + D1 4-type book
 * taxonomy) and #55 (count-definition, answered only-when-asked), plus the
 * Rule #47 "Step 0" orchestrator-first amendment.
 *
 * Assertion style mirrors `equipment-rules.spec.ts` / `decision-framing`:
 * token-presence checks against the exported prompt string. Append-only
 * guarantee: rules #1–#53 anchors survive; #54/#55 sit AFTER #53 and the
 * Thai-only closing line still terminates the prompt.
 */
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../executive-chat-system-prompt';

describe('answer-scope prompt rules #54 / #55', () => {
  it('rule #54 — HARD 3-domain answer-scope discipline', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '54. วินัยขอบเขตคำตอบตามเจตนาคำถาม',
    );
    expect(idx).toBeGreaterThan(-1);
    // Window 2400→3000: rule #54 grew a book-scoped project-listing clause
    // (B1 fix, 2026-07-18 — "โครงการในเล่มหลัก" must pass scope=main).
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 3000);
    // Book-scoped project listing guard (B1).
    expect(tail).toContain('book-scoped');
    expect(tail).toContain("scope='main'");
    // 3-domain gate.
    expect(tail).toContain('domain "เล่ม"');
    expect(tail).toContain('domain "โครงการ"');
    expect(tail).toContain('domain "ครุภัณฑ์"');
    // Hard-no-p-across-domain.
    expect(tail).toContain('ห้ามพ่วง');
    // D1 taxonomy — 4 distinct book types, edit ≠ change.
    expect(tail).toContain('เล่มหลัก / เล่มแก้ไข / เล่มเปลี่ยนแปลง / เล่มเพิ่มเติม');
    expect(tail).toContain('ห้ามเหมารวม');
    // Composite question opt-in + suggestion-block exemption.
    expect(tail).toContain('รวมโครงการด้วย');
    expect(tail).toContain('ข้อเสนอแนะ');
    // Direct-question exception (does not violate ENTERPRISE-TONE-03).
    expect(tail).toContain('มีเล่มเพิ่มเติมไหม');
    expect(tail).toContain('W-ENTERPRISE-TONE-03');
  });

  it('rule #55 — count-definition explained only when asked (no proactive)', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf('55. นิยามการนับ');
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1200);
    expect(tail).toContain('HEAD-of-lineage');
    expect(tail).toContain('ทุกเล่มทุกรอบ');
    expect(tail).toContain('ห้าม proactive');
  });

  it('rule #47 — Step 0 makes getPlanCatalogOverview orchestrator-first (manual = fallback)', () => {
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('Step 0 (บังคับ — orchestrator-first');
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      'Step 0 (บังคับ — orchestrator-first',
    );
    // Window widened 900→1400: Step 0 grew a book-type-count routing bullet
    // (2026-07-18 live-E2E fix — "เฉพาะเล่มเปลี่ยนแปลงมีกี่เล่ม" must route to
    // the orchestrator, not listActivePlans) which pushed the fallback line down.
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1400);
    expect(tail).toContain('getPlanCatalogOverview');
    expect(tail).toContain('fallback');
    expect(tail).toContain('4 ชนิด');
    // The new routing guard must forbid answering book-type questions from
    // listActivePlans alone.
    expect(tail).toContain('ห้ามใช้ `listActivePlans` เดี่ยว');
  });

  it('append-only — rules #53 anchor survives; #54/#55 sit after it; Thai closing line terminates', () => {
    const idx53 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '53. Anti-hallucination ครุภัณฑ์',
    );
    const idx54 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '54. วินัยขอบเขตคำตอบตามเจตนาคำถาม',
    );
    const idx55 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf('55. นิยามการนับ');
    expect(idx53).toBeGreaterThan(-1);
    expect(idx54).toBeGreaterThan(idx53);
    expect(idx55).toBeGreaterThan(idx54);
    expect(
      EXECUTIVE_CHAT_SYSTEM_PROMPT.trimEnd().endsWith(
        'ทุกคำตอบตอบเป็นภาษาไทย เว้นแต่ผู้ใช้ถามเป็นภาษาอื่น',
      ),
    ).toBe(true);
  });
});
