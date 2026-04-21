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
    // With no subTypeCode, resolveSubType returns null → no [SUB_TYPE_SCOPE],
    // and callers would typically pass examplesBlock='' in that case. Confirm
    // the composer does not invent an [EXAMPLES] block on its own.
    const rule = NAKHON_RATCHASIMA_ISSUE_RULES[0];
    const combined = composeCriteriaContextBlock(rule);
    expect(combined).not.toContain('[SUB_TYPE_SCOPE]');
    expect(combined).not.toContain('[EXAMPLES]');
    expect(combined).toContain('[CRITERIA]');
  });
});
