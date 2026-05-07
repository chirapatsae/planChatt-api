/**
 * SEC-W44-01 — Attack class #5: PII exfiltration via tool-result payload.
 *
 * Threat model: A tool handler over-projects and returns personal-name
 * fields (`createdBy.user.firstName`, `.lastName`, `citizenId`, etc.).
 * Without redaction, those fields would be wrapped into
 * `<<<TOOL_RESULT>>>` and fed back to the LLM — a silent PII egress.
 *
 * Defenses:
 *  1. BE-W44-02 §9: handler PROJECTION excludes `createdBy` / user
 *     relations for `searchProjectsByKeyword`,
 *     `detectWorkflowAgingProjects`, `highlightBudgetOutliers`.
 *     (Grep-gate in SEC-W44-02 verifies no tool handler selects those
 *     fields.)
 *  2. SEC-W44-02 belt-and-braces: `PiiRedactorService.redactForPrompt(
 *     toolResult, EXECUTIVE_CHAT_TOOL_RESULT_POLICY, ...)` scrubs
 *     residual PII before the wrap.
 *
 * This spec tests defense layer #2 end-to-end against the REAL
 * redactor (no mock). Defense layer #1 (projection) is exercised by
 * the BE-W44-02 unit tests and a grep gate.
 */

import { PiiRedactorService } from 'src/common/pii/pii-redactor.service';
import { EXECUTIVE_CHAT_TOOL_RESULT_POLICY } from 'src/common/pii/field-policies';

describe('SEC-W44-01 / pii-in-tool-result (SEC-W44-02 integration)', () => {
  let redactor: PiiRedactorService;

  beforeEach(() => {
    redactor = new PiiRedactorService();
  });

  it('STRIPS createdBy.user.firstName / lastName from tool results', () => {
    const toolResult = {
      items: [
        {
          projectId: 'p1',
          name: 'โครงการ A',
          createdBy: { user: { firstName: 'สมชาย', lastName: 'ใจดี' } },
        },
        {
          projectId: 'p2',
          name: 'โครงการ B',
          createdBy: { user: { firstName: 'สมหญิง', lastName: 'สายใจ' } },
        },
      ],
    };

    const { output } = redactor.redactForPrompt(
      toolResult,
      EXECUTIVE_CHAT_TOOL_RESULT_POLICY,
      {
        endpoint: 'executive-chat',
        fieldPath: 'tool.searchProjectsByKeyword',
      },
    );

    for (const item of output.items) {
      const user = (
        (item as Record<string, unknown>).createdBy as Record<string, unknown>
      ).user as Record<string, unknown>;
      expect(user.firstName).toBeUndefined();
      expect(user.lastName).toBeUndefined();
    }
    // Non-PII fields are preserved.
    expect((output.items[0] as Record<string, unknown>).name).toBe('โครงการ A');
  });

  it('STRIPS citizenId even when nested under arbitrary paths', () => {
    const toolResult = {
      items: [
        {
          projectId: 'p1',
          nominatedBy: {
            profile: { citizenId: '1234567890123', position: 'นายก' },
          },
        },
      ],
    };
    const { output } = redactor.redactForPrompt(
      toolResult,
      EXECUTIVE_CHAT_TOOL_RESULT_POLICY,
      { endpoint: 'executive-chat' },
    );
    const profile = (
      (output.items[0] as Record<string, unknown>).nominatedBy as Record<
        string,
        unknown
      >
    ).profile as Record<string, unknown>;
    expect(profile.citizenId).toBeUndefined();
    expect(profile.position).toBe('นายก');
  });

  it('regex-redacts PII that leaked into a FREE-TEXT leaf (e.g. `name` contains a citizen ID)', () => {
    const toolResult = {
      items: [
        {
          projectId: 'p1',
          name: 'โครงการ 1-2345-67890-12-3 ถนนหมู่บ้าน',
        },
      ],
    };
    const { output, counts } = redactor.redactForPrompt(
      toolResult,
      EXECUTIVE_CHAT_TOOL_RESULT_POLICY,
      { endpoint: 'executive-chat' },
    );
    const name = (output.items[0] as Record<string, unknown>).name as string;
    expect(name).not.toContain('1-2345-67890-12-3');
    expect(name).toContain('[ข้อมูลส่วนบุคคล]');
    expect(counts.thaiId).toBeGreaterThanOrEqual(1);
  });

  it('email addresses inside tool-result strings are regex-redacted', () => {
    const toolResult = {
      items: [{ projectId: 'p1', contact: 'ติดต่อ a@b.go.th' }],
    };
    const { output } = redactor.redactForPrompt(
      toolResult,
      EXECUTIVE_CHAT_TOOL_RESULT_POLICY,
      { endpoint: 'executive-chat' },
    );
    expect((output.items[0] as Record<string, unknown>).contact).not.toContain(
      'a@b.go.th',
    );
  });

  /**
   * DEFENSE NOTE (for BE-W44-02):
   *  - `EXECUTIVE_CHAT_TOOL_RESULT_POLICY` relies on BARE-KEY fallback
   *    for `firstName`/`lastName`/etc. If a future tool renames a
   *    personal-name field (e.g. `contactName`), it will NOT be stripped
   *    by this policy — only regex-redacted. Cataloguing the new field
   *    path in `EXECUTIVE_CHAT_TOOL_RESULT_POLICY` is the correct fix.
   *  - BE-W44-02 integration test (per task §9.12) must assert the real
   *    SSE flow sends the REDACTED copy to `LlmClient`, and the
   *    UNREDACTED copy is persisted to `tool_result_json` for owner
   *    trace view only. This spec cannot run that end-to-end until
   *    the adapter lands.
   */
});
