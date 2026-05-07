/**
 * BE-W51-02 — Executive AI Chat auto-title generator.
 *
 * Contract under test (design §7.2 / §8, task §6):
 *
 *   1. `generateAutoTitleIfEligible` calls the LLM with the static
 *      title-generation system prompt + the delimited user input,
 *      response_format `json_object`, gpt-4o-mini, temperature 0.3.
 *   2. Validates the response against `{title: string}`; strips control
 *      chars; rejects any output containing `<` or `>`; clamps via the
 *      40-cell visible budget.
 *   3. Runs `PiiRedactorService.redactText` on the VALIDATED title
 *      before persist (§17.9 defense-in-depth).
 *   4. Persists via compare-and-set: `WHERE title_source =
 *      'default-placeholder' AND deleted_at IS NULL`. A pre-check
 *      additionally short-circuits the LLM call when the row is no
 *      longer in the placeholder state.
 *   5. Emits a `checkAndLogUsage` call with
 *      `usageType='executive-chat-autotitle'` and the returned token
 *      counts.
 *   6. Is strictly non-throwing: every failure mode (LLM 5xx, JSON
 *      parse, schema drift, redactor throw, DB error) is logged and
 *      swallowed.
 *
 * CLAUDE.md references:
 *   §12    — no tracking_status write is asserted (by construction:
 *            the helper has no reference to the tracking repo).
 *   §17.2  — advisory; neither the call nor its failure gates any
 *            workflow transition.
 *   §17.5  — idempotency verified via the pre-check on `titleSource`.
 *   §17.8  — endpoint key is `executive-chat-autotitle`, distinct
 *            from the user-facing `executive-chat` cooldown bucket.
 *   §17.9  — HTML/`<`,`>` rejection + PiiRedactor on LLM output.
 *   §17.11 — compare-and-set is integrity, not permission; no role
 *            bypass exists.
 */
import { AiExecutiveChatService } from '../ai-executive-chat.service';
import { AiExecutiveConversation } from '../entities/ai-executive-conversation.entity';

type TitleSource = 'default-placeholder' | 'llm-auto' | 'user-rename';

interface FakeConvRow {
  id: string;
  titleSource: TitleSource;
  title: string;
  titleGeneratedAt: Date | null;
  deletedAt: Date | null;
}

// ───────────────────────────────────────────────────────────────────
// Fake ConversationRepo — supports:
//   - findOne({ where: { id, deletedAt: IsNull() } })
//   - createQueryBuilder().update(...).set(...).where(...).andWhere(...)
//     .execute() with the compare-and-set filter.
//
// The in-memory row store is shared across findOne + update so the
// pre-check and the write both observe the same truth.
// ───────────────────────────────────────────────────────────────────

function makeFakeConversationRepo(seed: FakeConvRow) {
  const rows: Record<string, FakeConvRow> = { [seed.id]: { ...seed } };
  let updateCount = 0;

  const repo = {
    async findOne(opts: { where: { id: string } }) {
      const row = rows[opts.where.id];
      if (!row || row.deletedAt) return null;
      return row as unknown as AiExecutiveConversation;
    },
    createQueryBuilder() {
      // Capture mutations between chained calls.
      let patch: Partial<FakeConvRow> = {};
      let targetId: string | null = null;
      let requirePlaceholder = false;
      let requireNotDeleted = false;
      const qb: Record<string, unknown> = {};
      qb.update = (_entity?: unknown) => qb;
      qb.set = (p: Partial<FakeConvRow>) => {
        patch = p;
        return qb;
      };
      qb.where = (_s: string, p: { id: string }) => {
        targetId = p.id;
        return qb;
      };
      qb.andWhere = (s: string, _p?: unknown) => {
        if (s.includes("title_source = 'default-placeholder'")) {
          requirePlaceholder = true;
        }
        if (s.includes('deleted_at IS NULL')) {
          requireNotDeleted = true;
        }
        return qb;
      };
      qb.execute = async () => {
        updateCount += 1;
        if (!targetId) return { affected: 0 };
        const row = rows[targetId];
        if (!row) return { affected: 0 };
        if (requireNotDeleted && row.deletedAt) return { affected: 0 };
        if (requirePlaceholder && row.titleSource !== 'default-placeholder') {
          return { affected: 0 };
        }
        Object.assign(row, patch);
        return { affected: 1 };
      };
      return qb;
    },
  };

  return {
    repo,
    rows,
    getUpdateCount: () => updateCount,
  };
}

// ───────────────────────────────────────────────────────────────────
// Fake PiiRedactor / LlmClient / QuotaService
// ───────────────────────────────────────────────────────────────────

function makeFakePiiRedactor(overrides?: {
  redactText?: (input: string) => string;
}) {
  const calls: Array<{ input: string; endpoint: string }> = [];
  return {
    redactText: jest.fn((input: string, ctx: { endpoint: string }) => {
      calls.push({ input, endpoint: ctx.endpoint });
      const output = overrides?.redactText
        ? overrides.redactText(input)
        : input;
      return {
        output,
        counts: {
          thaiId: 0,
          thaiPhone: 0,
          email: 0,
          longDigit: 0,
          address: 0,
          postal: 0,
        },
      };
    }),
    redactStructuredFields: jest.fn(),
    redactForPrompt: jest.fn(),
    getCalls: () => calls,
  };
}

function makeFakeLlmClient(
  handler:
    | {
        content: string;
        usage?: { prompt_tokens: number; completion_tokens: number };
      }
    | ((params: unknown) => Promise<unknown>)
    | Error,
) {
  const calls: Array<{ params: unknown }> = [];
  return {
    providerName: 'stub' as const,
    createChatCompletion: jest.fn(async (params: unknown) => {
      calls.push({ params });
      if (handler instanceof Error) throw handler;
      if (typeof handler === 'function') {
        return handler(params);
      }
      return {
        choices: [
          {
            message: { role: 'assistant', content: handler.content },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: {
          prompt_tokens: handler.usage?.prompt_tokens ?? 150,
          completion_tokens: handler.usage?.completion_tokens ?? 18,
          total_tokens:
            (handler.usage?.prompt_tokens ?? 150) +
            (handler.usage?.completion_tokens ?? 18),
        },
      };
    }),
    createChatCompletionStream: jest.fn(),
    getCalls: () => calls,
  };
}

function makeFakeQuotaService(shouldThrow = false) {
  const calls: Array<{
    userId: string;
    costUsd: number;
    metadata: Record<string, unknown>;
  }> = [];
  return {
    checkAndLogUsage: jest.fn(
      async (
        userId: string,
        costUsd: number,
        metadata: Record<string, unknown>,
      ) => {
        calls.push({ userId, costUsd, metadata });
        if (shouldThrow) throw new Error('quota-unavailable');
      },
    ),
    getCalls: () => calls,
  };
}

// ───────────────────────────────────────────────────────────────────
// Service scaffold
// ───────────────────────────────────────────────────────────────────

function makeService(
  conversationRepo: unknown,
  piiRedactor: unknown,
  llmClient: unknown,
  quotaService: unknown,
): AiExecutiveChatService {
  const noop = {} as unknown;
  return new AiExecutiveChatService(
    noop as never, // DataSource
    conversationRepo as never, // conversationRepo
    noop as never, // messageRepo
    noop as never, // WorkHistory repo
    llmClient as never, // LLM_CLIENT
    piiRedactor as never, // PiiRedactorService
    quotaService as never, // AiUsageQuotasService
    noop as never, // QuotaOrgCapService
    noop as never, // UNIFIED_PROJECT_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // BUDGET_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // STATUS_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // GEO_ENRICHMENT (Wave 54 BE-W54-06)
    noop as never, // AGENCY_ENRICHMENT (Wave 54 BE-W54-06)
    noop as never, // RESILIENCE_ENVELOPE (Wave 54 BE-W54-07)
    noop as never, // ProjectLineageService (Wave 61)
  );
}

// White-box invoker — the method is private; bracket-access mirrors the
// idiom used in `hydration-ordering.spec.ts` and
// `resolve-conversation-advisory-lock.spec.ts`.
function callGenerate(
  svc: AiExecutiveChatService,
  conversationId: string,
  userId: string,
  redactedFirstUserMessage: string,
): Promise<void> {
  return (
    svc as unknown as {
      generateAutoTitleIfEligible: (
        conversationId: string,
        userId: string,
        redactedFirstUserMessage: string,
      ) => Promise<void>;
    }
  ).generateAutoTitleIfEligible(
    conversationId,
    userId,
    redactedFirstUserMessage,
  );
}

function baseRow(
  titleSource: TitleSource = 'default-placeholder',
): FakeConvRow {
  return {
    id: 'conv-001',
    titleSource,
    title: 'บทสนทนาใหม่',
    titleGeneratedAt: null,
    deletedAt: null,
  };
}

// ───────────────────────────────────────────────────────────────────
// Specs
// ───────────────────────────────────────────────────────────────────

describe('BE-W51-02 / generateAutoTitleIfEligible', () => {
  it('happy path — persists llm-auto title + logs usage with the autotitle endpoint key', async () => {
    const { repo, rows, getUpdateCount } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient({
      content: '{"title":"สรุปงบประมาณตำบลในเมือง"}',
      usage: { prompt_tokens: 180, completion_tokens: 20 },
    });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'ขอดูงบประมาณตำบลในเมือง');

    // LLM was called exactly once with the gpt-4o-mini + json_object shape.
    expect(llm.createChatCompletion).toHaveBeenCalledTimes(1);
    const params = llm.getCalls()[0].params as {
      model: string;
      response_format: { type: string };
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(params.model).toBe('gpt-4o-mini');
    expect(params.response_format).toEqual({ type: 'json_object' });
    expect(params.temperature).toBe(0.3);
    expect(params.max_tokens).toBe(64);
    expect(params.messages[0].role).toBe('system');
    expect(params.messages[1].role).toBe('user');
    // §17.9 — user content MUST be wrapped in the delimiter pair.
    expect(params.messages[1].content).toContain('<<<USER_INPUT>>>');
    expect(params.messages[1].content).toContain('<<<END_USER_INPUT>>>');

    // Row was updated with the generated title.
    expect(getUpdateCount()).toBe(1);
    expect(rows['conv-001'].titleSource).toBe('llm-auto');
    expect(rows['conv-001'].title).toBe('สรุปงบประมาณตำบลในเมือง');
    expect(rows['conv-001'].titleGeneratedAt).toBeInstanceOf(Date);

    // Quota deducted with the autotitle endpoint key.
    expect(quota.checkAndLogUsage).toHaveBeenCalledTimes(1);
    const qMeta = quota.getCalls()[0].metadata as {
      usageType: string;
      inputTokens: number;
      outputTokens: number;
      modelName: string;
    };
    expect(qMeta.usageType).toBe('executive-chat-autotitle');
    expect(qMeta.modelName).toBe('gpt-4o-mini');
    expect(qMeta.inputTokens).toBe(180);
    expect(qMeta.outputTokens).toBe(20);
  });

  it('idempotent pre-check — titleSource=llm-auto ⇒ LLM NOT called, no write', async () => {
    const { repo, getUpdateCount } = makeFakeConversationRepo(
      baseRow('llm-auto'),
    );
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient({ content: '{"title":"ชื่อใหม่"}' });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'hello');

    expect(llm.createChatCompletion).not.toHaveBeenCalled();
    expect(getUpdateCount()).toBe(0);
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
  });

  it('idempotent pre-check — titleSource=user-rename ⇒ LLM NOT called, no write', async () => {
    const { repo, getUpdateCount } = makeFakeConversationRepo(
      baseRow('user-rename'),
    );
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient({ content: '{"title":"ชื่อใหม่"}' });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'hello');

    expect(llm.createChatCompletion).not.toHaveBeenCalled();
    expect(getUpdateCount()).toBe(0);
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
  });

  it('missing / soft-deleted conversation ⇒ no LLM call, no write, no throw', async () => {
    const deleted = baseRow();
    deleted.deletedAt = new Date();
    const { repo } = makeFakeConversationRepo(deleted);
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient({ content: '{"title":"x"}' });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await expect(
      callGenerate(svc, 'conv-001', 'user-xyz', 'hello'),
    ).resolves.toBeUndefined();

    expect(llm.createChatCompletion).not.toHaveBeenCalled();
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
  });

  it('LLM throws ⇒ no-op, no throw, no write, no usage deduction', async () => {
    const { repo, rows, getUpdateCount } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient(new Error('upstream 502'));
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await expect(
      callGenerate(svc, 'conv-001', 'user-xyz', 'hello'),
    ).resolves.toBeUndefined();

    expect(getUpdateCount()).toBe(0);
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
    expect(rows['conv-001'].titleSource).toBe('default-placeholder');
  });

  it('non-JSON LLM response ⇒ no-op placeholder retained', async () => {
    const { repo, rows, getUpdateCount } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient({ content: 'not json at all' });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'hello');

    expect(getUpdateCount()).toBe(0);
    expect(rows['conv-001'].titleSource).toBe('default-placeholder');
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
  });

  it('LLM response with empty title ⇒ no-op placeholder retained', async () => {
    const { repo, rows, getUpdateCount } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient({ content: '{"title":""}' });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'hello');

    expect(getUpdateCount()).toBe(0);
    expect(rows['conv-001'].titleSource).toBe('default-placeholder');
  });

  it('LLM response with HTML in title ⇒ rejected, placeholder retained', async () => {
    const { repo, rows, getUpdateCount } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient({
      content: '{"title":"<script>alert(1)</script>"}',
    });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'hello');

    expect(getUpdateCount()).toBe(0);
    expect(rows['conv-001'].titleSource).toBe('default-placeholder');
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
  });

  it('LLM response > 40 visible cells ⇒ clamped, NOT rejected', async () => {
    const { repo, rows } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    // 80 Thai chars — well over the 40-cell budget.
    const overflow = 'ก'.repeat(80);
    const llm = makeFakeLlmClient({
      content: JSON.stringify({ title: overflow }),
    });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'hello');

    expect(rows['conv-001'].titleSource).toBe('llm-auto');
    // 40-cell budget for Thai-only (weight=1.0) → <= 40 chars body + ellipsis.
    const persisted = rows['conv-001'].title;
    expect(persisted.length).toBeLessThanOrEqual(41); // 40 chars + one ellipsis char
    expect(persisted.endsWith('…')).toBe(true);
  });

  it('defense-in-depth — PiiRedactor runs on the LLM OUTPUT before persist', async () => {
    const { repo, rows } = makeFakeConversationRepo(baseRow());
    // This redactor flips any digit-heavy token to the placeholder token.
    const redactor = makeFakePiiRedactor({
      redactText: (input: string) =>
        input.includes('0812345678') ? 'ติดต่อ [ข้อมูลส่วนบุคคล]' : input,
    });
    const llm = makeFakeLlmClient({
      content: '{"title":"ติดต่อ 0812345678 ด่วน"}',
    });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'ขอเบอร์ติดต่อ');

    // Redactor is called on BOTH the input (defense-in-depth) and the
    // sanitised output. The persisted title MUST reflect the redacted
    // output, NOT the raw LLM string.
    expect(redactor.redactText).toHaveBeenCalled();
    expect(rows['conv-001'].title).toBe('ติดต่อ [ข้อมูลส่วนบุคคล]');
    expect(rows['conv-001'].titleSource).toBe('llm-auto');

    // Every redactor call used the auto-title endpoint key — it NEVER
    // shares the user-facing `executive-chat` cooldown namespace.
    const calls = redactor.getCalls();
    expect(calls.every((c) => c.endpoint === 'executive-chat-autotitle')).toBe(
      true,
    );
  });

  it('compare-and-set race — row flips to user-rename between pre-check and UPDATE ⇒ no overwrite', async () => {
    // Seed in the placeholder state so the pre-check passes and the LLM
    // call runs. Inside the LLM promise, flip the row to `user-rename`
    // to simulate the owner manually renaming in the intervening window.
    const { repo, rows } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient(async () => {
      // Simulate the owner renaming the conversation mid-LLM-call.
      rows['conv-001'].titleSource = 'user-rename';
      rows['conv-001'].title = 'ชื่อที่ผู้ใช้ตั้ง';
      return {
        choices: [
          {
            message: { role: 'assistant', content: '{"title":"auto"}' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      };
    });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'hello');

    // Auto-title UPDATE affected 0 rows because the compare-and-set
    // filter now fails. The owner's rename is preserved byte-for-byte.
    expect(rows['conv-001'].titleSource).toBe('user-rename');
    expect(rows['conv-001'].title).toBe('ชื่อที่ผู้ใช้ตั้ง');
    // Usage deduction is gated on `affected > 0`, so no baht is burned
    // on a lost race.
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
  });

  it("non-first-turn is not this method's concern — caller is responsible for the gate, but when invoked directly the method still respects the titleSource pre-check", async () => {
    // The caller in `runToolLoop` only invokes this method when
    // `seed.turnBaseIndex === 0`. Belt-and-braces: if a future caller
    // invokes it on an already-renamed row, the pre-check MUST still
    // short-circuit.
    const { repo } = makeFakeConversationRepo(baseRow('llm-auto'));
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient({ content: '{"title":"x"}' });
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-001', 'user-xyz', 'hello');

    expect(llm.createChatCompletion).toHaveBeenCalledTimes(0);
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
  });
});
