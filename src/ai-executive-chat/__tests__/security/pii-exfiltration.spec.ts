/**
 * SEC-W44-01 — Attack class #4: PII exfiltration via user message.
 *
 * Threat model: The executive pastes a document containing Thai citizen
 * IDs, phone numbers, or emails into the chat. If the payload reached
 * the LLM unredacted, PII would leave the organization boundary and be
 * logged on OpenAI's side (retention window, prompt-caching, training
 * opt-in, etc.).
 *
 * Defense (§17.9 complementary layer, SEC-W44-02):
 *   - `PiiRedactorService.redactForPrompt(payload,
 *      EXECUTIVE_CHAT_PROMPT_POLICY, {endpoint:'executive-chat'})` runs
 *     BEFORE the `wrapUserText` envelope.
 *   - Placeholder token is `[ข้อมูลส่วนบุคคล]` (constant in
 *     `pii-redactor.service.ts`). The user prompt requested
 *     `«CITIZEN_ID_001»` / `«PHONE_001»` / `«EMAIL_001»` style
 *     placeholders — the codebase uses a single constant placeholder
 *     per match today, so this spec asserts the real placeholder.
 *
 * This spec uses the REAL `PiiRedactorService` (per task spec) — no
 * mock. Telemetry emission is also asserted.
 */

import { Logger } from '@nestjs/common';
import { PiiRedactorService } from 'src/common/pii/pii-redactor.service';
import {
  EXECUTIVE_CHAT_PROMPT_POLICY,
  EXECUTIVE_CHAT_TOOL_RESULT_POLICY,
} from 'src/common/pii/field-policies';

const PLACEHOLDER = '[ข้อมูลส่วนบุคคล]';

describe('SEC-W44-01 / pii-exfiltration (SEC-W44-02 integration)', () => {
  let redactor: PiiRedactorService;

  beforeEach(() => {
    redactor = new PiiRedactorService();
  });

  it('Thai citizen ID (dashed) in user message is replaced with the placeholder', () => {
    const payload = { message: 'ประชาชน เลขบัตร 1-2345-67890-12-3 ขอข้อมูล' };
    const { output, counts } = redactor.redactForPrompt(
      payload,
      EXECUTIVE_CHAT_PROMPT_POLICY,
      { endpoint: 'executive-chat' },
    );
    expect(output.message).not.toContain('1-2345-67890-12-3');
    expect(output.message).toContain(PLACEHOLDER);
    expect(counts.thaiId).toBe(1);
  });

  it('bare-13 Thai citizen ID is redacted', () => {
    const payload = { message: 'เลข 1234567890123 แนบประวัติ' };
    const { output, counts } = redactor.redactForPrompt(
      payload,
      EXECUTIVE_CHAT_PROMPT_POLICY,
      { endpoint: 'executive-chat' },
    );
    expect(output.message).not.toContain('1234567890123');
    expect(output.message).toContain(PLACEHOLDER);
    expect(counts.thaiId).toBe(1);
  });

  it('Thai phone number is redacted', () => {
    const payload = { message: 'โทร 081-234-5678 เรื่องโครงการ' };
    const { output, counts } = redactor.redactForPrompt(
      payload,
      EXECUTIVE_CHAT_PROMPT_POLICY,
      { endpoint: 'executive-chat' },
    );
    expect(output.message).not.toContain('081-234-5678');
    expect(output.message).toContain(PLACEHOLDER);
    expect(counts.thaiPhone).toBe(1);
  });

  it('email in user message is redacted', () => {
    const payload = { message: 'ส่งอีเมลให้ somsak@example.go.th ด้วย' };
    const { output, counts } = redactor.redactForPrompt(
      payload,
      EXECUTIVE_CHAT_PROMPT_POLICY,
      { endpoint: 'executive-chat' },
    );
    expect(output.message).not.toContain('somsak@example.go.th');
    expect(output.message).toContain(PLACEHOLDER);
    expect(counts.email).toBe(1);
  });

  it('mixed PII in a single message is fully scrubbed and counts accumulate', () => {
    const payload = {
      message: 'ข้อมูล: 1-2345-67890-12-3 โทร 081-234-5678 อีเมล a@b.th',
    };
    const { output, counts } = redactor.redactForPrompt(
      payload,
      EXECUTIVE_CHAT_PROMPT_POLICY,
      { endpoint: 'executive-chat' },
    );
    expect(output.message).not.toContain('1-2345-67890-12-3');
    expect(output.message).not.toContain('081-234-5678');
    expect(output.message).not.toContain('a@b.th');
    expect(
      counts.thaiId + counts.thaiPhone + counts.email,
    ).toBeGreaterThanOrEqual(3);
  });

  it('telemetry is emitted with `event=pii.redact endpoint=executive-chat` and counts (not the payload)', () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    try {
      redactor.redactForPrompt(
        { message: 'เลขบัตร 1234567890123' },
        EXECUTIVE_CHAT_PROMPT_POLICY,
        { endpoint: 'executive-chat' },
      );
      expect(logSpy).toHaveBeenCalled();
      const emitted = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(emitted).toMatch(/event=pii\.redact/);
      expect(emitted).toMatch(/endpoint=executive-chat/);
      expect(emitted).toMatch(/thaiId=\d+/);
      // Must NOT contain the raw citizen ID.
      expect(emitted).not.toContain('1234567890123');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('personal-name fields (firstName/lastName) are STRIPPED per the baseline policy', () => {
    const payload = {
      message: 'hello',
      firstName: 'สมชาย',
      lastName: 'ใจดี',
    };
    const { output } = redactor.redactForPrompt(
      payload,
      EXECUTIVE_CHAT_PROMPT_POLICY,
      { endpoint: 'executive-chat' },
    );
    // 'strip' → deleted (not replaced).
    expect((output as Record<string, unknown>).firstName).toBeUndefined();
    expect((output as Record<string, unknown>).lastName).toBeUndefined();
  });

  it('tool-result policy redacts personal-name fields even when embedded deep in tool output', () => {
    // SEC-W44-02 applies `EXECUTIVE_CHAT_TOOL_RESULT_POLICY` to every
    // tool result. The policy strips baseline personal-name keys no
    // matter where they appear in the tree (bare-key fallback).
    const toolResult = {
      items: [
        {
          projectId: '00000000-0000-0000-0000-000000000000',
          name: 'โครงการทดสอบ',
          createdBy: {
            user: { firstName: 'สมชาย', lastName: 'ใจดี' },
          },
        },
      ],
    };
    const { output } = redactor.redactForPrompt(
      toolResult,
      EXECUTIVE_CHAT_TOOL_RESULT_POLICY,
      { endpoint: 'executive-chat', fieldPath: 'tool.searchProjectsByKeyword' },
    );
    const user = (
      (output.items[0] as Record<string, unknown>).createdBy as Record<
        string,
        unknown
      >
    ).user as Record<string, unknown>;
    expect(user.firstName).toBeUndefined();
    expect(user.lastName).toBeUndefined();
  });
});
