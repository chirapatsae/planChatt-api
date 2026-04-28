/**
 * BE-W51-03 — Executive AI Chat auto-title SSE emission.
 *
 * Contract under test (task §3 / §5 / §6):
 *
 *   1. On the happy path (compare-and-set `affected > 0` + quota
 *      deduction succeeded), `generateAutoTitleIfEligible` MUST emit
 *      a `conversation_renamed` SSE frame on the provided `response`
 *      sink with payload:
 *        { conversationId, title, titleSource: 'llm-auto',
 *          titleGeneratedAt: <ISO string> }.
 *   2. When the compare-and-set affects zero rows (concurrent
 *      user-rename / auto-title race loss), NO frame is emitted.
 *   3. When the pre-check short-circuits (`titleSource` already flipped
 *      away from `'default-placeholder'`), NO frame is emitted.
 *   4. Emission is best-effort: a `response.write` that throws
 *      (simulated torn-down socket) MUST NOT surface out of the
 *      fire-and-forget promise — the method still resolves cleanly.
 *   5. The `response` parameter is optional; when omitted the helper
 *      behaves identically to BE-W51-02 (no SSE emission, no throw).
 *
 * CLAUDE.md references:
 *   §12    — no tracking_status write; the SSE frame is informational.
 *   §17.2  — advisory; emission never gates any workflow transition.
 *   §17.3  — no FK introduced; the frame is transient wire metadata.
 *   §17.11 — no role-based bypass on the emission path; emission is
 *            keyed purely on "did the compare-and-set succeed?".
 */
import type { Response } from 'express';

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
// Fakes — mirror the shape used by auto-title-generation.spec.ts so
// the two suites stay in lock-step as BE-W51-02 evolves.
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

function makeFakePiiRedactor() {
  return {
    redactText: jest.fn((input: string) => ({
      output: input,
      counts: {
        thaiId: 0,
        thaiPhone: 0,
        email: 0,
        longDigit: 0,
        address: 0,
        postal: 0,
      },
    })),
    redactStructuredFields: jest.fn(),
    redactForPrompt: jest.fn(),
  };
}

function makeFakeLlmClient(content: string) {
  return {
    providerName: 'stub' as const,
    createChatCompletion: jest.fn(async () => ({
      choices: [
        {
          message: { role: 'assistant', content },
          finish_reason: 'stop',
          index: 0,
        },
      ],
      usage: { prompt_tokens: 150, completion_tokens: 18, total_tokens: 168 },
    })),
    createChatCompletionStream: jest.fn(),
  };
}

function makeFakeQuotaService() {
  return {
    checkAndLogUsage: jest.fn(async () => undefined),
  };
}

// ───────────────────────────────────────────────────────────────────
// Fake SSE response sink — records every `write` call. The `emit`
// helper on the service composes two `write` calls per frame
// (`event:` line + `data:` line). We parse both and surface a tidy
// `frames` list for assertions.
// ───────────────────────────────────────────────────────────────────

interface CapturedFrame {
  event: string;
  data: unknown;
}

function makeFakeResponse(opts?: { throwOnWrite?: boolean }): {
  response: Response;
  frames: CapturedFrame[];
  rawWrites: string[];
} {
  const rawWrites: string[] = [];
  const frames: CapturedFrame[] = [];
  let pendingEvent: string | null = null;

  const write = (chunk: unknown): boolean => {
    if (opts?.throwOnWrite) {
      throw new Error('write EPIPE — socket torn down');
    }
    const s = String(chunk);
    rawWrites.push(s);
    // Parse `event: <name>\n` and `data: <json>\n\n` pairs.
    const eventMatch = /^event:\s*(.+)\n$/.exec(s);
    if (eventMatch) {
      pendingEvent = eventMatch[1].trim();
      return true;
    }
    const dataMatch = /^data:\s*(.*)\n\n$/s.exec(s);
    if (dataMatch && pendingEvent) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataMatch[1]);
      } catch {
        parsed = dataMatch[1];
      }
      frames.push({ event: pendingEvent, data: parsed });
      pendingEvent = null;
    }
    return true;
  };

  const response = { write } as unknown as Response;
  return { response, frames, rawWrites };
}

// ───────────────────────────────────────────────────────────────────
// Service scaffold — mirrors auto-title-generation.spec.ts.
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

// White-box invoker — method is private; mirrors the bracket-access
// idiom in `auto-title-generation.spec.ts`.
function callGenerate(
  svc: AiExecutiveChatService,
  conversationId: string,
  userId: string,
  redactedFirstUserMessage: string,
  response?: Response,
): Promise<void> {
  return (
    svc as unknown as {
      generateAutoTitleIfEligible: (
        conversationId: string,
        userId: string,
        redactedFirstUserMessage: string,
        response?: Response,
      ) => Promise<void>;
    }
  ).generateAutoTitleIfEligible(
    conversationId,
    userId,
    redactedFirstUserMessage,
    response,
  );
}

function baseRow(titleSource: TitleSource = 'default-placeholder'): FakeConvRow {
  return {
    id: 'conv-042',
    titleSource,
    title: 'บทสนทนาใหม่',
    titleGeneratedAt: null,
    deletedAt: null,
  };
}

// ───────────────────────────────────────────────────────────────────
// Specs
// ───────────────────────────────────────────────────────────────────

describe('BE-W51-03 / auto-title conversation_renamed SSE emission', () => {
  it('happy path — emits exactly one conversation_renamed frame with the strict payload shape', async () => {
    const { repo, rows } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient('{"title":"สรุปงบประมาณตำบลในเมือง"}');
    const quota = makeFakeQuotaService();
    const sink = makeFakeResponse();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(
      svc,
      'conv-042',
      'user-xyz',
      'ขอดูงบประมาณตำบลในเมือง',
      sink.response,
    );

    // Persisted side: compare-and-set flipped the row.
    expect(rows['conv-042'].titleSource).toBe('llm-auto');
    expect(rows['conv-042'].title).toBe('สรุปงบประมาณตำบลในเมือง');

    // SSE side: exactly one `conversation_renamed` frame, strict payload.
    const renamedFrames = sink.frames.filter(
      (f) => f.event === 'conversation_renamed',
    );
    expect(renamedFrames).toHaveLength(1);

    const payload = renamedFrames[0].data as Record<string, unknown>;
    expect(payload.conversationId).toBe('conv-042');
    expect(payload.title).toBe('สรุปงบประมาณตำบลในเมือง');
    expect(payload.titleSource).toBe('llm-auto');
    expect(typeof payload.titleGeneratedAt).toBe('string');
    // ISO timestamp: round-trips through Date without NaN.
    expect(
      Number.isNaN(Date.parse(payload.titleGeneratedAt as string)),
    ).toBe(false);

    // The frame carries no `type` field — SSE event name lives on the
    // `event:` line, not in the `data:` JSON payload (matches the
    // existing `message_complete` / `done` wire shape).
    expect(Object.prototype.hasOwnProperty.call(payload, 'type')).toBe(false);
  });

  it('compare-and-set race loss — no frame emitted when the UPDATE affects 0 rows', async () => {
    // Seed placeholder → pre-check passes → LLM is called. The LLM
    // mock flips `titleSource` to `'user-rename'` mid-call so the
    // compare-and-set filter rejects the UPDATE.
    const { repo, rows } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = {
      providerName: 'stub' as const,
      createChatCompletion: jest.fn(async () => {
        rows['conv-042'].titleSource = 'user-rename';
        rows['conv-042'].title = 'ชื่อที่ผู้ใช้ตั้ง';
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
      }),
      createChatCompletionStream: jest.fn(),
    };
    const quota = makeFakeQuotaService();
    const sink = makeFakeResponse();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-042', 'user-xyz', 'hello', sink.response);

    // Owner's rename survives byte-for-byte.
    expect(rows['conv-042'].titleSource).toBe('user-rename');
    expect(rows['conv-042'].title).toBe('ชื่อที่ผู้ใช้ตั้ง');

    // Critical: ZERO `conversation_renamed` frames emitted. A race-loss
    // MUST NOT leak a stale title onto the wire.
    const renamedFrames = sink.frames.filter(
      (f) => f.event === 'conversation_renamed',
    );
    expect(renamedFrames).toHaveLength(0);

    // Usage deduction is gated on `affected > 0` too — keeps parity
    // with BE-W51-02's race-loss contract.
    expect(quota.checkAndLogUsage).not.toHaveBeenCalled();
  });

  it('pre-check short-circuit — no frame emitted when titleSource is already flipped', async () => {
    // titleSource=llm-auto → pre-check returns early BEFORE the LLM
    // call. Nothing should reach the emission path.
    const { repo } = makeFakeConversationRepo(baseRow('llm-auto'));
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient('{"title":"ชื่อใหม่"}');
    const quota = makeFakeQuotaService();
    const sink = makeFakeResponse();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-042', 'user-xyz', 'hello', sink.response);

    expect(llm.createChatCompletion).not.toHaveBeenCalled();
    expect(sink.frames).toHaveLength(0);
  });

  it('pre-check short-circuit — no frame emitted for user-rename titleSource', async () => {
    const { repo } = makeFakeConversationRepo(baseRow('user-rename'));
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient('{"title":"ชื่อใหม่"}');
    const quota = makeFakeQuotaService();
    const sink = makeFakeResponse();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-042', 'user-xyz', 'hello', sink.response);

    expect(llm.createChatCompletion).not.toHaveBeenCalled();
    expect(sink.frames).toHaveLength(0);
  });

  it('schema-drift path — no frame emitted when LLM returns non-JSON', async () => {
    // Validator rejects → no compare-and-set → no emission.
    const { repo, rows } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient('not json at all');
    const quota = makeFakeQuotaService();
    const sink = makeFakeResponse();

    const svc = makeService(repo, redactor, llm, quota);
    await callGenerate(svc, 'conv-042', 'user-xyz', 'hello', sink.response);

    expect(rows['conv-042'].titleSource).toBe('default-placeholder');
    const renamedFrames = sink.frames.filter(
      (f) => f.event === 'conversation_renamed',
    );
    expect(renamedFrames).toHaveLength(0);
  });

  it('best-effort emission — response.write throwing MUST NOT bubble out of the promise', async () => {
    // Happy path succeeds (compare-and-set flips the row) BUT the
    // socket is torn down at emission time. The simulated throw
    // represents an EPIPE / ERR_STREAM_DESTROYED. The helper MUST
    // still resolve cleanly and the persisted state MUST still
    // reflect the llm-auto write.
    const { repo, rows } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient('{"title":"สรุปประเด็น"}');
    const quota = makeFakeQuotaService();
    const sink = makeFakeResponse({ throwOnWrite: true });

    const svc = makeService(repo, redactor, llm, quota);
    await expect(
      callGenerate(svc, 'conv-042', 'user-xyz', 'hello', sink.response),
    ).resolves.toBeUndefined();

    // Persistence was NOT rolled back by the socket failure.
    expect(rows['conv-042'].titleSource).toBe('llm-auto');
    expect(rows['conv-042'].title).toBe('สรุปประเด็น');

    // No frames landed (writes threw); but the helper did NOT crash.
    expect(sink.frames).toHaveLength(0);
  });

  it('backward-compatible — omitting the response parameter yields identical persistence with zero SSE activity', async () => {
    // Guards against a future regression where the emission path
    // accidentally becomes mandatory. BE-W51-02's contract is that
    // `response` is OPTIONAL.
    const { repo, rows } = makeFakeConversationRepo(baseRow());
    const redactor = makeFakePiiRedactor();
    const llm = makeFakeLlmClient('{"title":"หัวข้อสรุป"}');
    const quota = makeFakeQuotaService();

    const svc = makeService(repo, redactor, llm, quota);
    await expect(
      callGenerate(svc, 'conv-042', 'user-xyz', 'hello' /* no response */),
    ).resolves.toBeUndefined();

    expect(rows['conv-042'].titleSource).toBe('llm-auto');
    expect(rows['conv-042'].title).toBe('หัวข้อสรุป');
  });
});
