/**
 * Wave 39 N3 — Unit tests for `composeExamplesSection` and the prompt
 * ordering contract of `composeCriteriaContextBlock`.
 *
 * - `composeExamplesSection` fallback behavior (null rule, null/unknown
 *   subTypeCode, missing exampleActivities) → empty string.
 * - Happy path → emits `[EXAMPLES]` ... `[END_EXAMPLES]` with bullet
 *   lines per activity and the advisory "วัตถุดิบทางเลือก" framing.
 * - Prompt ordering: when `examplesBlock` is provided and a sub-type
 *   resolves, the final combined block MUST position `[EXAMPLES]`
 *   strictly between `[SUB_TYPE_SCOPE]` and `[CRITERIA]`.
 *
 * Advisory / static system content per CLAUDE.md §17.2 + §17.9.
 */

import {
  composeCriteriaContextBlock,
  composeExamplesSection,
  composeMultiEntryCriteriaContextBlock,
} from './compose-criteria-context';
import { NAKHON_RATCHASIMA_ISSUE_RULES } from './nakhon-ratchasima-issue-rules';

describe('composeExamplesSection — Wave 39 N2', () => {
  it('returns empty string when matchedRule is null', () => {
    expect(composeExamplesSection(null, '4.1')).toBe('');
  });

  it('returns empty string when subTypeCode is null or undefined', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    expect(composeExamplesSection(rule, null)).toBe('');
    expect(composeExamplesSection(rule, undefined)).toBe('');
  });

  it('returns empty string when subTypeCode is empty string', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    expect(composeExamplesSection(rule, '')).toBe('');
  });

  it('returns empty string when sub-type code is not found in rule', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    expect(composeExamplesSection(rule, 'NONEXISTENT_CODE')).toBe('');
  });

  it('emits [EXAMPLES] block when sub-type resolves with exampleActivities', () => {
    // Find any sub-type known to have exampleActivities (all 19 do post-N1).
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES.find((r) =>
      r.subTypes.some(
        (st) => st.exampleActivities && st.exampleActivities.length > 0,
      ),
    );
    expect(rule).toBeDefined();
    const st = rule!.subTypes.find(
      (s) => s.exampleActivities && s.exampleActivities.length > 0,
    )!;

    const out = composeExamplesSection(rule!, st.code);

    expect(out).toContain('[EXAMPLES]');
    expect(out).toContain('[END_EXAMPLES]');
    expect(out).toContain(`ประเภทย่อย "${st.label}"`);
    // At least one example line rendered with bullet prefix.
    expect(out).toContain(`- ${st.exampleActivities![0]}`);
    // Advisory framing present.
    expect(out).toContain('วัตถุดิบทางเลือก');
  });

  it('renders every exampleActivities entry as a bullet line', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES.find((r) =>
      r.subTypes.some((st) => (st.exampleActivities?.length ?? 0) >= 4),
    )!;
    const st = rule.subTypes.find(
      (s) => (s.exampleActivities?.length ?? 0) >= 4,
    )!;

    const out = composeExamplesSection(rule, st.code);

    for (const example of st.exampleActivities!) {
      expect(out).toContain(`- ${example}`);
    }
  });

  it('emission includes the detail-attributes directive (ชื่อกิจกรรม · สถานที่ ...)', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const st = rule.subTypes.find(
      (s) => (s.exampleActivities?.length ?? 0) > 0,
    )!;
    const out = composeExamplesSection(rule, st.code);
    expect(out).toContain('ชื่อกิจกรรม');
    expect(out).toContain('สถานที่/กลุ่มเป้าหมาย');
  });
});

describe('composeCriteriaContextBlock — Wave 39 N2 [EXAMPLES] prompt ordering', () => {
  it('positions [EXAMPLES] strictly between [SUB_TYPE_SCOPE] and [CRITERIA]', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const subTypeCode = rule.subTypes[0].code;

    const examplesBlock = composeExamplesSection(rule, subTypeCode);
    expect(examplesBlock.length).toBeGreaterThan(0);

    const combined = composeCriteriaContextBlock(rule, {
      subTypeCode,
      examplesBlock,
    });

    const idxSubTypeScope = combined.indexOf('[SUB_TYPE_SCOPE]');
    const idxExamples = combined.indexOf('[EXAMPLES]');
    const idxEndExamples = combined.indexOf('[END_EXAMPLES]');
    const idxCriteria = combined.indexOf('[CRITERIA]');

    expect(idxSubTypeScope).toBeGreaterThanOrEqual(0);
    expect(idxExamples).toBeGreaterThan(idxSubTypeScope);
    expect(idxEndExamples).toBeGreaterThan(idxExamples);
    expect(idxCriteria).toBeGreaterThan(idxEndExamples);
  });

  it('omits [EXAMPLES] block when examplesBlock opt is missing / empty', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const subTypeCode = rule.subTypes[0].code;

    const withoutExamples = composeCriteriaContextBlock(rule, {
      subTypeCode,
    });
    expect(withoutExamples).not.toContain('[EXAMPLES]');
    expect(withoutExamples).not.toContain('[END_EXAMPLES]');
    // [SUB_TYPE_SCOPE] and [CRITERIA] still present.
    expect(withoutExamples).toContain('[SUB_TYPE_SCOPE]');
    expect(withoutExamples).toContain('[CRITERIA]');

    const withEmpty = composeCriteriaContextBlock(rule, {
      subTypeCode,
      examplesBlock: '',
    });
    expect(withEmpty).not.toContain('[EXAMPLES]');
  });

  it('renders [CRITERIA] before [EXAMPLES] would have appeared when sub-type does NOT resolve', () => {
    // With no subTypeCode, resolveSubType returns null → no [SUB_TYPE_SCOPE]
    // header block, and callers would typically pass examplesBlock='' in
    // that case. Confirm the composer does not invent an [EXAMPLES] block
    // on its own.
    //
    // 2026-05-21 — assertion tightened from .not.toContain('[SUB_TYPE_SCOPE]')
    // to a line-anchored regex because the [RULES] directive text legitimately
    // mentions `[SUB_TYPE_SCOPE]` by name (Wave 28 N1 anti-mix harden) — the
    // bare substring check would always fail. Test now verifies the BLOCK
    // HEADER specifically, which is the original intent.
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const combined = composeCriteriaContextBlock(rule);
    expect(combined).not.toMatch(/^\[SUB_TYPE_SCOPE\]$/m);
    expect(combined).not.toMatch(/^\[EXAMPLES\]$/m);
    expect(combined).toMatch(/^\[CRITERIA\]$/m);
  });
});

// ---------------------------------------------------------------------------
// Wave LAO_STRATEGY_AI_PARITY — Node N1 tests for
// `composeMultiEntryCriteriaContextBlock`. See task file
// `docs/tasks/wave-lao-strategy-ai-parity/N1-composer-multi-entry.md`.
// ---------------------------------------------------------------------------
describe('composeMultiEntryCriteriaContextBlock — Wave LAO_STRATEGY_AI_PARITY N1', () => {
  const RULESET_VERSION = '2026-04-18';

  // Helper to find an entry by issueKey from the frozen registry.
  const byKey = (key: string) => {
    const e = NAKHON_RATCHASIMA_ISSUE_RULES.find((r) => r.issueKey === key);
    if (!e) throw new Error(`Fixture: issueKey ${key} not found in registry`);
    return e;
  };

  it('N=0 returns empty string (no header emitted)', () => {
    const out = composeMultiEntryCriteriaContextBlock([], {
      format: 'STRATEGY_BASED',
      rulesetVersion: RULESET_VERSION,
      strategyName: 'ยุทธศาสตร์ทดสอบ',
    });
    expect(out).toBe('');
  });

  it('N=1 ISSUE_BASED is byte-identical to existing single-entry composer output (regression baseline)', () => {
    // Pick a stable registry entry; first entry is royal-initiated.
    const entry = NAKHON_RATCHASIMA_ISSUE_RULES[0];

    const baseline = composeCriteriaContextBlock(entry);
    const multi = composeMultiEntryCriteriaContextBlock([entry], {
      format: 'ISSUE_BASED',
      rulesetVersion: RULESET_VERSION,
      issueName: entry.issueDisplayName,
    });

    expect(multi).toBe(baseline);
  });

  it('N=1 STRATEGY_BASED short-circuits to single-entry composer with format=STRATEGY_BASED [OUTPUT] block', () => {
    // 2026-05-22 — original assertion ("byte-identical to single-entry
    // composer regardless of format") was relaxed to fix the LAO +
    // STRATEGY_BASED budget-card bug: the single-entry composer's
    // hard-coded ISSUE_BASED `[OUTPUT]` directive ("ห้ามส่งค่า indicator"
    // + 4-section `เท่านั้น` whitelist) suppressed both indicator AND
    // งบประมาณ when the LLM ran under STRATEGY_BASED. The composer now
    // emits a format-correct `[OUTPUT]` block; N=1 STRATEGY_BASED must
    // therefore differ from N=1 ISSUE_BASED in the `[OUTPUT]` section
    // only. Everything else (ISSUE / SUB_TYPES / CRITERIA / RULES) is
    // still byte-identical between the two formats for the same entry.
    const entry = byKey('economic-3-1');

    const issueBaseline = composeCriteriaContextBlock(entry); // defaults to ISSUE_BASED
    const strategyBaseline = composeCriteriaContextBlock(entry, {
      format: 'STRATEGY_BASED',
    });
    const multi = composeMultiEntryCriteriaContextBlock([entry], {
      format: 'STRATEGY_BASED',
      rulesetVersion: RULESET_VERSION,
      strategyName: 'ยุทธศาสตร์เศรษฐกิจ',
    });

    // Multi-entry N=1 STRATEGY_BASED equals the single-entry composer
    // when called WITH `format: STRATEGY_BASED` (the new short-circuit).
    expect(multi).toBe(strategyBaseline);
    // And differs from the ISSUE_BASED default ONLY at the [OUTPUT] block.
    expect(multi).not.toBe(issueBaseline);
    expect(multi).toContain('เนื่องจากเป็น STRATEGY_BASED');
    expect(multi).toContain('งบประมาณ'); // canonical heading list now includes budget
    expect(issueBaseline).toContain('เนื่องจากเป็น ISSUE_BASED');
  });

  it('N=2 STRATEGY_BASED renders both economic-3-1 + economic-3-2 with disambiguated [ISSUE] sub-blocks and boundary delimiter', () => {
    const e1 = byKey('economic-3-1');
    const e2 = byKey('economic-3-2');

    const out = composeMultiEntryCriteriaContextBlock([e1, e2], {
      format: 'STRATEGY_BASED',
      rulesetVersion: RULESET_VERSION,
      strategyName: 'ยุทธศาสตร์เศรษฐกิจฐานราก',
    });

    // Top-level STRATEGY_BASED format header present, with matched
    // count + strategyName + rulesetVersion.
    expect(out).toContain('[FORMAT]');
    expect(out).toContain('STRATEGY_BASED');
    expect(out).toContain('ยุทธศาสตร์เศรษฐกิจฐานราก');
    expect(out).toContain('2 ประเด็นการพัฒนา');
    expect(out).toContain(`rulesetVersion: ${RULESET_VERSION}`);

    // Boundary delimiter appears between the two per-entry blocks.
    expect(out).toContain('[ISSUE_BOUNDARY]');

    // BOTH entries' issueKeys disambiguate the per-entry [ISSUE] blocks.
    expect(out).toContain('issueKey): economic-3-1');
    expect(out).toContain('issueKey): economic-3-2');

    // Wave AI-Enforcement-Model (2026-05-22) — [CRITERIA] section now
    // filters to enforcement='llm-prose' only. economic-3-2 has C3_2.c
    // (auto-check geo) and C3_2.d (staff-only) which are NOT shown to
    // the LLM. Only C3_2.b (llm-prose "คุ้มค่า") survives. Assertions
    // updated accordingly.
    expect(out).toContain('C3_2.b'); // llm-prose — shown
    expect(out).not.toContain('C3_2.c'); // auto-check — filtered
    expect(out).not.toContain('C3_2.d'); // staff-only — filtered
    expect(out).not.toContain('C3_2.e'); // staff-only — filtered

    // economic-3-1 criteria also present (sanity). C3_1.a/b are
    // llm-prose; C3_1.c is auto-check (title-uniqueness) — filtered.
    expect(out).toContain('C3_1.a');
    expect(out).toContain('C3_1.b');
    expect(out).not.toContain('C3_1.c');

    // Ordering: economic-3-1 block precedes the boundary, which
    // precedes the economic-3-2 block.
    const idxKey1 = out.indexOf('issueKey): economic-3-1');
    const idxBoundary = out.indexOf('[ISSUE_BOUNDARY]');
    const idxKey2 = out.indexOf('issueKey): economic-3-2');
    expect(idxKey1).toBeGreaterThan(-1);
    expect(idxBoundary).toBeGreaterThan(idxKey1);
    expect(idxKey2).toBeGreaterThan(idxBoundary);
  });
});

// ---------------------------------------------------------------------------
// Wave LAO-STRATEGY-AI-PARITY Followup G+R Coherence (2026-05-22) —
// `[CRITERIA_OUTPUT_REQUIREMENTS]` block. Generator now receives explicit
// instructions to address every criterion in the produced content with
// concrete values (or a clearly-tagged "(ตัวอย่างจาก AI — โปรดยืนยัน)"
// placeholder). Goal: lift downstream pre-submit-review scores by closing
// the previous Generator/Reviewer rubric gap (production observation
// 2026-05-22 — score=59/100 with 2 high-priority "จำเป็น" suggestions for
// content the Generator never knew it had to provide).
//
// Advisory-only per §17.2; static system content sourced from registry
// per §17.9. The tag string is a presentational convention recognized by
// the Reviewer prompt (see ai.service.ts + staff-review-prompt.service.ts).
// ---------------------------------------------------------------------------
describe('composeCriteriaContextBlock — [CRITERIA_OUTPUT_REQUIREMENTS] (Followup G+R Coherence)', () => {
  it('emits the [CRITERIA_OUTPUT_REQUIREMENTS] section header (ISSUE_BASED default)', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const out = composeCriteriaContextBlock(rule);
    expect(out).toMatch(/^\[CRITERIA_OUTPUT_REQUIREMENTS\]$/m);
  });

  it('emits the same block for STRATEGY_BASED (format-independent — both flows want same Generator discipline)', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const out = composeCriteriaContextBlock(rule, {
      format: 'STRATEGY_BASED',
    });
    expect(out).toMatch(/^\[CRITERIA_OUTPUT_REQUIREMENTS\]$/m);
  });

  it('includes the canonical placeholder tag string (Reviewer recognizes this exact tag — must not drift)', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const out = composeCriteriaContextBlock(rule);
    // The tag string is a frozen contract shared between Generator and
    // Reviewer prompts. If this assertion fails, the Reviewer-side
    // interpretation rules in ai.service.ts + staff-review-prompt.service.ts
    // MUST be updated in lockstep, otherwise the Reviewer would penalize
    // tagged placeholders as missing data.
    expect(out).toContain('(ตัวอย่างจาก AI — โปรดยืนยัน)');
  });

  it('appears AFTER [RULES] and BEFORE [OUTPUT] in the section ordering', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const out = composeCriteriaContextBlock(rule);
    const idxRules = out.indexOf('[RULES]');
    const idxReq = out.indexOf('[CRITERIA_OUTPUT_REQUIREMENTS]');
    const idxOutput = out.indexOf('[OUTPUT]');
    expect(idxRules).toBeGreaterThan(-1);
    expect(idxReq).toBeGreaterThan(idxRules);
    expect(idxOutput).toBeGreaterThan(idxReq);
  });

  it('forbids the "เช่น"-only-no-example failure mode (explicit directive present)', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const out = composeCriteriaContextBlock(rule);
    // Generator must not emit dangling "เช่น" without a concrete example
    // afterwards — this was a common LLM failure pattern.
    expect(out).toContain('เช่น');
    expect(out).toContain('เป็นต้น');
  });

  it('multi-entry N>1 composer propagates the block into EACH per-entry sub-block', () => {
    // The new [CRITERIA_OUTPUT_REQUIREMENTS] block is added to the
    // single-entry composer, which the multi-entry composer delegates
    // to for each entry. The block should therefore appear N times in
    // an N-entry STRATEGY_BASED composition.
    const e1 = NAKHON_RATCHASIMA_ISSUE_RULES.find(
      (r) => r.issueKey === 'economic-3-1',
    );
    const e2 = NAKHON_RATCHASIMA_ISSUE_RULES.find(
      (r) => r.issueKey === 'economic-3-2',
    );
    if (!e1 || !e2) throw new Error('Fixture: economic registry entries not found');

    const out = composeMultiEntryCriteriaContextBlock([e1, e2], {
      format: 'STRATEGY_BASED',
      rulesetVersion: '2026-04-18',
      strategyName: 'ยุทธศาสตร์เศรษฐกิจฐานราก',
    });

    const matches = out.match(/\[CRITERIA_OUTPUT_REQUIREMENTS\]/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Wave Evidence-Scope Decoupling (2026-05-22) — Generator MUST NOT prompt
// the LLM to write prose about evidence/attachment/permit/document.
//
// Background: Production observation 2026-05-22 — STRAT003 LAO test
// produced a "ควรระบุหลักฐานการขออนุญาตใช้พื้นที่" suggestion, docking
// the score to 59. The suggestion is misplaced because:
//   * AI cannot read attachments — only prose
//   * The user can't "fix" this by editing prose
//   * Document verification is a STAFF review concern, not AI
// ---------------------------------------------------------------------------
describe('composeCriteriaContextBlock — Evidence-Scope Decoupling rule #6', () => {
  it('emits rule #6 declaring evidence/attachment criteria out of prose scope', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const out = composeCriteriaContextBlock(rule);
    // Rule #6 mentions all four canonical evidence keywords so the LLM
    // recognizes the concept regardless of which synonym a criterion uses.
    expect(out).toContain('หลักฐาน');
    expect(out).toContain('เอกสารแนบ');
    expect(out).toContain('ใบอนุญาต');
    expect(out).toContain('ใบรับรอง');
    expect(out).toContain('ระบบจะตรวจสอบจากไฟล์แนบ');
    // The "blocking criticality" reinforcement explicitly excludes
    // evidence-related criteria so the LLM doesn't double-bind on them.
    expect(out).toContain(
      'หลักเกณฑ์ที่ criticality = "blocking" และไม่ใช่หลักเกณฑ์เรื่องเอกสารแนบ',
    );
  });

  it('rule #6 appears for STRATEGY_BASED too (format-independent — separation-of-concerns is format-agnostic)', () => {
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const out = composeCriteriaContextBlock(rule, {
      format: 'STRATEGY_BASED',
    });
    expect(out).toContain('ระบบจะตรวจสอบจากไฟล์แนบ');
  });
});
