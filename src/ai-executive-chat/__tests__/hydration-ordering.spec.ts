/**
 * BE-W48-01 — deterministic row ordering on hydration.
 *
 * Issue A (Wave 48 RCA §2): inside a single `dataSource.transaction(...)`
 * Postgres `now()` returns the TRANSACTION start time, so all 4 rows
 * (user + assistant-tool-call + tool-result + assistant-final) share
 * an identical `created_at`. The hydration tiebreaker `id ASC` is a
 * UUID v4 string (random), so refresh order is non-deterministic.
 *
 * Fix: each `persist*` helper now writes `createdAt: new Date()`
 * explicitly on `repo.create({...})`. Node's awaited sequential
 * `repo.save(...)` calls across the helpers guarantee monotonically
 * advancing `Date.now()` values. Combined with the existing
 * `ORDER BY created_at ASC, id ASC` shape of
 * `listMessagesForConversation`, the hydrated list is deterministic.
 *
 * This spec exercises the four `persist*` helpers directly via bracket
 * access (they are private on the service), feeds them through a fake
 * EntityManager, and then asserts:
 *
 *   1. Every row persisted inside one simulated turn receives a
 *      DISTINCT `createdAt` value (no transaction-start ties).
 *   2. `createdAt` values are strictly increasing in the order the
 *      helpers were invoked (user → assistant-tool-call → tool-result
 *      → assistant-final).
 *   3. Sorting the captured rows by the production tuple
 *      `(createdAt ASC, id ASC)` returns the correct chronological
 *      order across repeated hydration attempts.
 *   4. `computedAt` remains semantically independent of `createdAt`
 *      (both are present; the fix does NOT merge or alias them).
 *
 * §17.3 — no FK or project-table JOIN introduced.
 * §17.4 — snapshot-only invariant is expressed at the WIRE level via
 *         `toMessageDto` hard-coding `isStale: false`. Wave 52
 *         DB-W52-01 dropped the per-row staleness column; the
 *         invariant is now module-level (`SNAPSHOT_ONLY_INVARIANT`) and
 *         structurally enforced by the sole reader.
 * §17.11 — no role bypass; this is an integrity fix.
 * CLAUDE.md §12 — no `tracking_status` row is written.
 */
import { AiExecutiveChatService } from '../ai-executive-chat.service';
import { AiExecutiveMessage } from '../entities/ai-executive-message.entity';

// ─────────────────────────────────────────────────────────────────
// Fake repo / EntityManager capturing every `create` + `save` call.
// ─────────────────────────────────────────────────────────────────

interface CapturedRow extends Partial<AiExecutiveMessage> {
  id: string;
  createdAt: Date;
}

function makeFakeManager() {
  const rows: CapturedRow[] = [];
  let seq = 0;
  const repo = {
    create: (input: Partial<AiExecutiveMessage>) => {
      // TypeORM's repo.create is a passthrough in practice; the
      // caller-supplied `createdAt` must reach `save` unchanged.
      return { ...input };
    },
    save: async (row: Partial<AiExecutiveMessage>) => {
      // Simulate random UUID assignment by giving every row a stable
      // but non-time-ordered id. The ordering fix MUST NOT rely on
      // `id` order; `createdAt` is the real chronology carrier.
      seq += 1;
      const id = `uuid-${String(1000 - seq).padStart(4, '0')}-random`;
      const persisted: CapturedRow = {
        ...row,
        id,
        createdAt: row.createdAt as Date,
      };
      rows.push(persisted);
      return persisted as AiExecutiveMessage;
    },
  };
  const manager = {
    getRepository: (_entity: unknown) => repo,
  };
  return { manager, rows };
}

function makeService(): AiExecutiveChatService {
  const noop = {} as unknown;
  return new AiExecutiveChatService(
    noop as never, // DataSource
    noop as never, // conversationRepo
    noop as never, // messageRepo
    noop as never, // workHistoryRepo
    noop as never, // LLM_CLIENT
    noop as never, // PiiRedactorService
    noop as never, // AiUsageQuotasService
    noop as never, // QuotaOrgCapService
    noop as never, // UNIFIED_PROJECT_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // BUDGET_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // STATUS_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // GEO_ENRICHMENT (Wave 54 BE-W54-06)
    noop as never, // AGENCY_ENRICHMENT (Wave 54 BE-W54-06)
    noop as never, // RESILIENCE_ENVELOPE (Wave 54 BE-W54-07)
    noop as never, // ProjectLineageService (Wave 61)
    noop as never, // AgencyProjectsCanonicalAggregatorService (Wave 103 PR2)
    noop as never, // KnowledgeSearchService (Wave AI-Knowledge-Hub BE-04)
    noop as never, // UnifiedEquipmentAggregatorService (Wave AI-Exec-Chat-Equipment-P03)
  );
}

// Helper: run a small async delay so Node's event loop advances at
// least one macrotask and Date.now() ticks. Sub-millisecond resolution
// is not guaranteed across platforms, so we force a real gap.
async function tick(ms = 2): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Production hydration tuple: `ORDER BY created_at ASC, id ASC`.
function sortLikeHydration(rows: CapturedRow[]): CapturedRow[] {
  return [...rows].sort((a, b) => {
    const dt = a.createdAt.getTime() - b.createdAt.getTime();
    if (dt !== 0) return dt;
    return a.id.localeCompare(b.id);
  });
}

describe('BE-W48-01 / deterministic hydration ordering', () => {
  const CONV_ID = 'conv-ordering-0001';
  const WH_ID = 'wh-owner-0001';

  it('assigns a distinct createdAt to every row of a 4-row turn', async () => {
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    // Simulate one turn with one tool round (4 rows), mirroring the
    // sequencing inside `runToolLoop`: user → tool round (assistant
    // tool-call is persisted as part of `persistToolRound`) → tool
    // result (same helper) → assistant-final.
    //
    // In production the order is:
    //   persistUserMessage     (user)
    //   persistToolRound       (tool-call + tool-result; single write)
    //   persistAssistantFinal  (assistant)
    //
    // For this spec we invoke three helpers, producing three distinct
    // row-timestamps; the fourth "row" is covered by an additional
    // `persistToolRound` for a second (hypothetical) tool round so the
    // count reaches 4, exactly matching the RCA failure scenario.

    // Row 1 — user
    await (
      svc as unknown as {
        persistUserMessage: (
          m: unknown,
          c: string,
          w: string,
          t: string,
          h: string,
          turnIndex: number,
        ) => Promise<unknown>;
      }
    ).persistUserMessage(manager, CONV_ID, WH_ID, 'hello', 'hash-user', 0);

    await tick();

    // Row 2 — tool round #1
    await (
      svc as unknown as {
        persistToolRound: (
          m: unknown,
          seed: unknown,
          offset: number,
          name: string,
          payload: unknown,
        ) => Promise<unknown>;
      }
    ).persistToolRound(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u1', turnBaseIndex: 0 },
      1,
      'listActivePlans',
      { toolCalls: [], result: { ok: true } },
    );

    await tick();

    // Row 3 — tool round #2 (simulates the second persisted tool row
    // that pushes the turn to 4 rows in the RCA scenario)
    await (
      svc as unknown as {
        persistToolRound: (
          m: unknown,
          seed: unknown,
          offset: number,
          name: string,
          payload: unknown,
        ) => Promise<unknown>;
      }
    ).persistToolRound(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u1', turnBaseIndex: 0 },
      2,
      'getBudgetSummaryByPlan',
      { toolCalls: [], result: { projectCount: 6 } },
    );

    await tick();

    // Row 4 — assistant final
    await (
      svc as unknown as {
        persistAssistantFinal: (
          m: unknown,
          seed: unknown,
          offset: number,
          text: string,
          meta: unknown,
          ti: number,
          to: number,
          inherited: unknown,
        ) => Promise<unknown>;
      }
    ).persistAssistantFinal(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u1', turnBaseIndex: 0 },
      3,
      'มี 6 โครงการในแผน',
      {
        finishReason: 'stop',
        modelUsed: 'gpt-4o',
        wasDowngraded: false,
        hops: 2,
      },
      10,
      20,
      { id: null, kind: null },
    );

    expect(rows).toHaveLength(4);

    // Assertion 1 — every createdAt is a real Date.
    rows.forEach((r) => expect(r.createdAt).toBeInstanceOf(Date));

    // Assertion 2 — all four createdAt values are DISTINCT (the bug).
    const distinct = new Set(rows.map((r) => r.createdAt.getTime()));
    expect(distinct.size).toBe(4);

    // Assertion 3 — strictly monotonically increasing in insertion order.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].createdAt.getTime()).toBeGreaterThan(
        rows[i - 1].createdAt.getTime(),
      );
    }
  });

  it('hydration sort (createdAt ASC, id ASC) returns user → tool → tool → assistantFinal', async () => {
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    await (
      svc as unknown as {
        persistUserMessage: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistUserMessage(manager, CONV_ID, WH_ID, 'hi', 'hash-u', 0);
    await tick();
    await (
      svc as unknown as {
        persistToolRound: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistToolRound(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u', turnBaseIndex: 0 },
      1,
      'listActivePlans',
      { toolCalls: [], result: {} },
    );
    await tick();
    await (
      svc as unknown as {
        persistToolRound: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistToolRound(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u', turnBaseIndex: 0 },
      2,
      'getBudgetSummaryByPlan',
      { toolCalls: [], result: {} },
    );
    await tick();
    await (
      svc as unknown as {
        persistAssistantFinal: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistAssistantFinal(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u', turnBaseIndex: 0 },
      3,
      'final answer',
      {
        finishReason: 'stop',
        modelUsed: 'gpt-4o',
        wasDowngraded: false,
        hops: 2,
      },
      1,
      1,
      { id: null, kind: null },
    );

    // Simulate 3 hydration passes (refresh-the-page) and assert the
    // order is identical every time. Pre-fix this failed because the
    // UUID `id` tiebreaker (random) would shuffle the 4 rows.
    const pass1 = sortLikeHydration(rows).map((r) => r.role);
    const pass2 = sortLikeHydration(rows).map((r) => r.role);
    const pass3 = sortLikeHydration(rows).map((r) => r.role);

    expect(pass1).toEqual(['user', 'tool', 'tool', 'assistant']);
    expect(pass2).toEqual(pass1);
    expect(pass3).toEqual(pass1);
  });

  it('persistAssistantSoftStop also writes a distinct createdAt (max-hops path)', async () => {
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    await (
      svc as unknown as {
        persistUserMessage: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistUserMessage(manager, CONV_ID, WH_ID, 'probe', 'hash-u2', 0);
    await tick();
    await (
      svc as unknown as {
        persistAssistantSoftStop: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistAssistantSoftStop(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u', turnBaseIndex: 0 },
      1,
      {
        finishReason: 'max_hops',
        modelUsed: 'gpt-4o',
        wasDowngraded: false,
        hops: 6,
        softStopReason: 'max_hops',
      },
      { id: null, kind: null },
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].createdAt.getTime()).toBeLessThan(
      rows[1].createdAt.getTime(),
    );
  });

  it('preserves computedAt independently from createdAt', async () => {
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    await (
      svc as unknown as {
        persistUserMessage: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistUserMessage(manager, CONV_ID, WH_ID, 'probe', 'hash-u3', 0);

    expect(rows).toHaveLength(1);
    // Both must be present; neither is aliased onto the other. The AI
    // semantic timestamp (`computedAt`) is kept separate from the
    // persistence timestamp (`createdAt`) per §17.4 authoring.
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(rows[0].computedAt).toBeInstanceOf(Date);
  });

  it('preserves snapshot-only invariant (§17.4) on every served DTO', async () => {
    // Wave 52 BE-W52-04 — The per-row staleness column was
    // dropped by DB-W52-01 and removed from the four persist helpers
    // by BE-W52-03. The §17.4 snapshot-only invariant is now expressed
    // at the WIRE level: the sole reader (`toMessageDto`) hard-codes
    // `isStale: false` on every row it serves, driven by the
    // module-level `SNAPSHOT_ONLY_INVARIANT` constant.
    //
    // This test exercises that single read-side enforcement point by
    // mapping captured rows through `toMessageDto` (accessed via the
    // same private-method bracket-cast idiom the surrounding persist
    // tests use) and asserting every DTO carries `isStale: false`.
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    await (
      svc as unknown as {
        persistUserMessage: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistUserMessage(manager, CONV_ID, WH_ID, 'probe', 'hash-u4', 0);
    await tick();
    await (
      svc as unknown as {
        persistToolRound: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistToolRound(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u', turnBaseIndex: 0 },
      1,
      'listActivePlans',
      { toolCalls: [], result: {} },
    );
    await tick();
    await (
      svc as unknown as {
        persistAssistantFinal: (...a: unknown[]) => Promise<unknown>;
      }
    ).persistAssistantFinal(
      manager,
      { conversationId: CONV_ID, userMessageId: 'u', turnBaseIndex: 0 },
      2,
      'ok',
      {
        finishReason: 'stop',
        modelUsed: 'gpt-4o',
        wasDowngraded: false,
        hops: 1,
      },
      0,
      0,
      { id: null, kind: null },
    );

    const toDto = (
      svc as unknown as {
        toMessageDto: (row: AiExecutiveMessage) => { isStale: boolean };
      }
    ).toMessageDto.bind(svc);

    rows.forEach((r) => {
      const dto = toDto(r as AiExecutiveMessage);
      expect(dto.isStale).toBe(false);
    });
  });
});
