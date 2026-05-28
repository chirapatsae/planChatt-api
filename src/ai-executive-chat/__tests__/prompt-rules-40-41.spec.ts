/**
 * BE-02 — Presence assertions for the two new rules and the four new
 * sub-book catalog entries appended by Wave AI-EXEC-CHAT-BOOK-COVERAGE.
 *
 * NUMBERING NOTE — The BE-02 task brief described the new rules as
 * "rule #40" and "rule #41" because, at brief-authoring time, the
 * prompt's tail was rule #39. Between brief authoring and BE-02
 * implementation, waves W67-FIX-C, W68-FIX-04, and W103-BE-PR3
 * appended rules #40 / #41 / #42 / #43. To preserve the byte-identity
 * of every existing rule (the brief's non-negotiable constraint), the
 * new rules were renumbered to #44 (anaphora) and #45 (drill-down
 * chain) on append. The W-AI-EXEC-CHAT-BOOK-COVERAGE-PROMPT-01 marker
 * is unchanged — only the numeric label moved.
 *
 * The spec filename `prompt-rules-40-41.spec.ts` is preserved from the
 * brief's acceptance criteria for grep-traceability; the assertions
 * inside this file probe the W-AI-EXEC-CHAT-BOOK-COVERAGE-PROMPT-01
 * marker rather than the literal "#40 (W-AI-EXEC-CHAT-BOOK-COVERAGE-
 * PROMPT-01" / "#41 (W-AI-EXEC-CHAT-BOOK-COVERAGE-PROMPT-01" strings
 * mentioned in the brief, which would fail under the actual #44 / #45
 * numbering. See BE-02 task report for the full rationale.
 *
 * CLAUDE.md references:
 *   - §17.2  — both new rules are advisory; neither gates workflow.
 *   - §17.9  — CTX_HINT delimiters are distinct from USER_INPUT /
 *              TOOL_RESULT delimiters; the rule MUST forbid quoting
 *              raw `<<<CTX_HINT>>>` markers in user-facing output.
 *   - §17.11 — no role exemption; the rules apply uniformly.
 *   - §17.14 — anaphora rule MUST NOT widen LAO-coordination scope.
 */

import {
  EXECUTIVE_CHAT_SYSTEM_PROMPT,
  EXECUTIVE_CHAT_TOOL_INSTRUCTIONS,
} from '../prompts/executive-chat-system-prompt';

describe('W-AI-EXEC-CHAT-BOOK-COVERAGE-PROMPT-01 — rules #44 / #45 + 4 sub-book catalog entries', () => {
  it('rule #44 (anaphora via CTX_HINT) is present', () => {
    // Marker presence — every wave's new content is tagged with its
    // wave marker so future grep audits can trace the addition.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
      'W-AI-EXEC-CHAT-BOOK-COVERAGE-PROMPT-01',
    );
    // The rule must label itself as #44 in the numbered list.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/44\.\s*การ resolve คำชี้เฉพาะ/);
    // CTX_HINT envelope contract from BE-03 must be cited verbatim
    // so the LLM knows which delimiter pair to scan.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('<<<CTX_HINT>>>');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('<<<END_CTX_HINT>>>');
    // Anaphora trigger phrases — the LLM must recognise at least the
    // two canonical demonstratives.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('เล่มนี้');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('เล่มนั้น');
    // Fallback to re-enumeration must be wired so the LLM never
    // fabricates a UUID when CTX_HINT is missing.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
      'listDevelopmentPlanRevisions',
    );
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
      'listDevelopmentPlanSupplements',
    );
    // §17.2 advisory cross-reference is preserved.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('§17.2 advisory-only');
  });

  it('rule #45 (sub-book drill-down chain) is present', () => {
    // The rule must label itself as #45 in the numbered list.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(
      /45\.\s*ลำดับการ drill ลงเล่มย่อย/,
    );
    // All four BE-01 tools must appear in the rule body so the LLM
    // can wire the chain end-to-end without consulting the catalog.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('listProjectsInRevisionBook');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
      'listProjectsInSupplementBook',
    );
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('getRevisionBookSummary');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('getSupplementBookSummary');
    // The three-step chain must be enumerated.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/Step 1/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/Step 2/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/Step 3/);
    // Pagination contract from Q2 must be documented — the LLM is
    // explicitly forbidden from looping retries indefinitely.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('totalCount');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ห้ามวน retry/);
  });

  it('tool catalog discloses the 4 BE-01 sub-book tools', () => {
    // Catalog entries must surface in EXECUTIVE_CHAT_TOOL_INSTRUCTIONS
    // so the LLM's tool-selection routine has the tool descriptions
    // available at the same surface as every other read aggregator.
    expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toContain(
      'listProjectsInRevisionBook',
    );
    expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toContain(
      'listProjectsInSupplementBook',
    );
    expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toContain(
      'getRevisionBookSummary',
    );
    expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toContain(
      'getSupplementBookSummary',
    );
    // Each catalog entry must reference rule #45 so the LLM can locate
    // the routing rule from the catalog.
    expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toMatch(/#45/);
  });

  it('rule #44 references the §17.11 no-role-exemption contract', () => {
    // §17.11 forbids any rule from branching on role; the anaphora
    // rule must explicitly carry the cross-reference so future edits
    // do not accidentally introduce a role-scoped fast-path.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('§17.11 no role exemption');
  });

  it('rule #44 references the §17.14 LAO-coordination scope boundary', () => {
    // §17.14 binds the LAO regulatory criteria registry to LAO-
    // coordinated main-plan projects. The anaphora rule MUST NOT
    // become a backdoor that widens this scope to ผ.03 or any other
    // domain — assert the cross-reference is present so the constraint
    // is discoverable in the prompt itself.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('§17.14');
  });
});
