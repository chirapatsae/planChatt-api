/**
 * Wave AI-EXEC-CHAT-LIVE-QA-4BUG — prompt-rule spec for the routing rules
 * landed from the multi-persona live QA sweep:
 *   - Rule #67 (BUG1): classification breakdown ("แยกตามยุทธศาสตร์/ประเด็น")
 *     MUST route to getExecutiveDashboardSnapshot groupBy=strategy/issue;
 *     getProjectClassificationBreakdown is FORBIDDEN (main-PG-only undercount).
 *   - Rule #68 (BUG4): single-project keyword extraction — strip trailing
 *     question words before searchProjectsByKeyword.
 *   - Rule #69 (BUG2-minor): answer-language + suggestion-integrity + ties.
 *
 * Append-only guarantee: #66 anchor survives, #67/#68/#69 sit AFTER it, and
 * the Thai-only closing line still terminates the prompt.
 */
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../executive-chat-system-prompt';

describe('live-QA-4bug prompt rules #67 / #68 / #69', () => {
  it('rule #67 — classification breakdown routes to dashboard, forbids the undercounting tool', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '67. สรุปโครงการ "แยกตามยุทธศาสตร์',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1400);
    expect(tail).toContain('getExecutiveDashboardSnapshot');
    expect(tail).toContain("groupBy=['strategy']");
    expect(tail).toContain("groupBy=['issue']");
    // The forbidden main-PG-only tool + the undercount reason.
    expect(tail).toContain('getProjectClassificationBreakdown');
    expect(tail).toContain('ห้ามเด็ดขาด');
    expect(tail).toContain('RevisedProjectGroup');
  });

  it('rule #68 — single-project keyword extraction strips trailing question words', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '68. การสกัดคำค้นชื่อโครงการเดี่ยว',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1200);
    expect(tail).toContain('searchProjectsByKeyword');
    expect(tail).toContain('เกี่ยวกับอะไร');
    expect(tail).toContain('คืออะไร');
    // The concrete BUG4 example project.
    expect(tail).toContain('ศูนย์การเรียนรู้ดิจิทัล');
  });

  it('rule #69 — answer-language (with English example) + suggestion-integrity + ties', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '69. วินัยเพิ่มเติม',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1600);
    // Answer in the user's language + explicit English example.
    expect(tail).toContain('ภาษาเดียวกับที่ผู้ใช้ถาม');
    expect(tail).toContain('There are 3 projects in the main book');
    // Suggestions must not invent a nonexistent plan.
    expect(tail).toContain('2570-2574');
    // Ties.
    expect(tail).toContain('เสมอ');
  });

  it('rule #70 — "which project has highest budget" routes per-project, forbids plan-total', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '70. "โครงการไหนงบสูงสุด"',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1400);
    // Correct per-project tool + English trigger.
    expect(tail).toContain('highlightBudgetOutliers');
    expect(tail).toContain('which project has the highest budget');
    // Forbid the plan-aggregate tools.
    expect(tail).toContain('getCrossPlanInsights');
    expect(tail).toContain('ห้ามเด็ดขาด');
    // Tie ground truth (both 2M projects).
    expect(tail).toContain('ศูนย์การเรียนรู้ดิจิทัล 2,000,000');
  });

  it('rule #64 — in-book count triggers now cover English paraphrases (BUG-B)', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '64. จำนวนโครงการ/ครุภัณฑ์ "ในเล่มเดียว"',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1900);
    expect(tail).toContain('how many projects/equipment');
    expect(tail).toContain('number of projects in the');
    // English paraphrases must NOT default to getPlanOverview.
    expect(tail).toContain('ห้าม default ไป getPlanOverview');
  });

  it('append-only — #66 anchor survives; #67/#68/#69/#70 sit after it; Thai closing line terminates', () => {
    const idx66 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '66. สุขอนามัยการ render label',
    );
    const idx67 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '67. สรุปโครงการ "แยกตามยุทธศาสตร์',
    );
    const idx68 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '68. การสกัดคำค้นชื่อโครงการเดี่ยว',
    );
    const idx69 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf('69. วินัยเพิ่มเติม');
    const idx70 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf('70. "โครงการไหนงบสูงสุด"');
    expect(idx66).toBeGreaterThan(-1);
    expect(idx67).toBeGreaterThan(idx66);
    expect(idx68).toBeGreaterThan(idx67);
    expect(idx69).toBeGreaterThan(idx68);
    expect(idx70).toBeGreaterThan(idx69);
    expect(
      EXECUTIVE_CHAT_SYSTEM_PROMPT.trimEnd().endsWith(
        'ทุกคำตอบตอบเป็นภาษาไทย เว้นแต่ผู้ใช้ถามเป็นภาษาอื่น',
      ),
    ).toBe(true);
  });
});
