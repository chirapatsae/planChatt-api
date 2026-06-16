/**
 * BE-W50-01 — `turn_index` is the authoritative ordering key.
 *
 * Wave 48 introduced an explicit per-row `createdAt: new Date()` to
 * break the `now()` transaction-start tie on the four rows of a single
 * turn. Wave 50 RCA §2.1 G1/G2 identified two residual edges:
 *
 *   1. `new Date()` has ms resolution; two `await repo.save()` calls
 *      resolving in the same ms on a fast box produce identical
 *      `createdAt`, forcing the tuple to fall back on `id ASC`. The
 *      UUID-v4 `id` is random, so `id ASC` is deterministic-per-
 *      dataset but semantically wrong.
 *   2. There was no integer monotonic counter per conversation, so
 *      the hydration read, the LLM history replay, and the
 *      `DISTINCT ON` preview query all inherited the same ambiguity.
 *
 * DB-W50-01 added `turn_index INTEGER NOT NULL` + composite index
 * `(conversation_id, turn_index)`. BE-W50-01 promotes that column to
 * the authoritative sort key and emits it on every DTO.
 *
 * This spec exercises the four `persist*` helpers directly (matching
 * the idiom in `hydration-ordering.spec.ts`), feeds them through a
 * fake EntityManager, and asserts:
 *
 *   1. Every row in a 4-row turn carries the expected `turnIndex`
 *      (`turnBaseIndex + 0/1/2/3`).
 *   2. Hydration sort by `turnIndex ASC` returns the exact canonical
 *      order `user → assistantToolCall → toolResult → assistantFinal`
 *      invariant across 100 randomized `id` generations.
 *   3. Concurrent `persistUserMessage` calls on the same conversation
 *      produce strictly monotonic `turnIndex` values when the caller
 *      has computed distinct bases (the standard turn-transaction
 *      contract). Same-base collision is a caller bug, not a helper
 *      bug — documented below.
 *   4. `turn_index` is independent of `createdAt` (Wave 48 belt-and-
 *      braces timestamp is still present on every row).
 *
 * §17.3  — no FK, no project-table JOIN introduced.
 * §17.4  — snapshot-only invariant is expressed at the WIRE level via
 *          `toMessageDto` hard-coding `isStale: false`. Wave 52
 *          DB-W52-01 dropped the per-row staleness column; the
 *          invariant is now module-level (`SNAPSHOT_ONLY_INVARIANT`)
 *          and structurally enforced by the sole reader.
 * §17.11 — integrity, not permission; no role bypass possible.
 * §12    — zero `tracking_status` writes.
 */
import { AiExecutiveChatService } from '../ai-executive-chat.service';
import { AiExecutiveMessage } from '../entities/ai-executive-message.entity';

// ─────────────────────────────────────────────────────────────────
// Fake EntityManager / repo capturing every row written.
// Mirrors the `hydration-ordering.spec.ts` scaffold but with a
// configurable `id` generator so we can randomize UUIDs across runs.
// ─────────────────────────────────────────────────────────────────

interface CapturedRow extends Partial<AiExecutiveMessage> {
  id: string;
  createdAt: Date;
  turnIndex: number;
}

function makeFakeManager(opts: { idGen?: () => string } = {}) {
  const rows: CapturedRow[] = [];
  const idGen =
    opts.idGen ??
    (() =>
      // Fallback: short random suffix.
      `uuid-${Math.random().toString(16).slice(2, 10)}`);
  const repo = {
    create: (input: Partial<AiExecutiveMessage>) => ({ ...input }),
    save: async (row: Partial<AiExecutiveMessage>) => {
      const persisted: CapturedRow = {
        ...row,
        id: idGen(),
        createdAt: row.createdAt as Date,
        turnIndex: (row as { turnIndex?: number }).turnIndex ?? 0,
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
  );
}

// Canonical hydration sort per BE-W50-01: `turn_index ASC, id ASC`.
function sortLikeHydration(rows: CapturedRow[]): CapturedRow[] {
  return [...rows].sort((a, b) => {
    const dt = a.turnIndex - b.turnIndex;
    if (dt !== 0) return dt;
    return a.id.localeCompare(b.id);
  });
}

// White-box helpers — the four persist* methods are private on the
// service; we reach through the instance exactly like the existing
// `hydration-ordering.spec.ts` does.

type PersistUserFn = (...args: any[]) => Promise<unknown>;

type PersistToolFn = (...args: any[]) => Promise<unknown>;

type PersistFinalFn = (...args: any[]) => Promise<unknown>;

async function simulateFourRowTurn(
  svc: AiExecutiveChatService,
  manager: unknown,
  conversationId: string,
  turnBaseIndex: number,
): Promise<void> {
  // Row 0 — user
  await (
    svc as unknown as { persistUserMessage: PersistUserFn }
  ).persistUserMessage(
    manager,
    conversationId,
    'wh-owner',
    'hello',
    `hash-u-${turnBaseIndex}`,
    turnBaseIndex + 0,
  );
  // Row 1 — tool round #1 (assistant-tool-call + tool-result are one
  // persisted row in the current helper design; see BE-W45-01).
  await (
    svc as unknown as { persistToolRound: PersistToolFn }
  ).persistToolRound(
    manager,
    { conversationId, userMessageId: 'u', turnBaseIndex },
    1,
    'listActivePlans',
    { toolCalls: [], result: { ok: true } },
  );
  // Row 2 — tool round #2 (second hop).
  await (
    svc as unknown as { persistToolRound: PersistToolFn }
  ).persistToolRound(
    manager,
    { conversationId, userMessageId: 'u', turnBaseIndex },
    2,
    'getBudgetSummaryByPlan',
    { toolCalls: [], result: { projectCount: 6 } },
  );
  // Row 3 — assistant final.
  await (
    svc as unknown as { persistAssistantFinal: PersistFinalFn }
  ).persistAssistantFinal(
    manager,
    { conversationId, userMessageId: 'u', turnBaseIndex },
    3,
    'final answer',
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
}

// ─────────────────────────────────────────────────────────────────
// Specs
// ─────────────────────────────────────────────────────────────────

describe('BE-W50-01 / turn_index ordering', () => {
  const CONV = 'conv-turn-index-0001';

  it('writes turnIndex = baseIndex + [0,1,2,3] across a 4-row turn', async () => {
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    await simulateFourRowTurn(svc, manager, CONV, 0);

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.turnIndex)).toEqual([0, 1, 2, 3]);
  });

  it('monotonically advances turnIndex when a subsequent turn starts at baseIndex = 4', async () => {
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    await simulateFourRowTurn(svc, manager, CONV, 0);
    await simulateFourRowTurn(svc, manager, CONV, 4);

    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.turnIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('hydration sort (turn_index ASC) returns user → tool → tool → assistantFinal invariant across 100 randomized id generations', async () => {
    for (let iter = 0; iter < 100; iter++) {
      const svc = makeService();
      // Feed each row a fresh random UUID so the `id ASC` tiebreaker
      // would shuffle if turn_index were not driving the sort.
      const { manager, rows } = makeFakeManager({
        idGen: () =>
          `uuid-${Math.random().toString(16).slice(2, 10)}-${Math.random()
            .toString(16)
            .slice(2, 10)}`,
      });
      await simulateFourRowTurn(svc, manager, CONV, 0);

      const roles = sortLikeHydration(rows).map((r) => r.role);
      expect(roles).toEqual(['user', 'tool', 'tool', 'assistant']);
    }
  });

  it('concurrent persistUserMessage calls with distinct turnIndex bases produce non-colliding rows', async () => {
    // Contract: the CALLER (turn transaction) is responsible for
    // assigning distinct `turnBaseIndex` values under the advisory
    // lock. This spec validates the helper-level invariant: given
    // distinct `turnIndex` values, the writer never mutates or
    // coalesces them. Same-base collision is a caller bug, not a
    // helper bug — that scenario is guarded by BE-W50-02's advisory
    // lock + the `(conversation_id, turn_index)` DB index which
    // would reject duplicates at INSERT time in production.
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    await Promise.all([
      (
        svc as unknown as { persistUserMessage: PersistUserFn }
      ).persistUserMessage(manager, CONV, 'wh-owner', 'a', 'hash-a', 0),
      (
        svc as unknown as { persistUserMessage: PersistUserFn }
      ).persistUserMessage(manager, CONV, 'wh-owner', 'b', 'hash-b', 1),
    ]);

    expect(rows).toHaveLength(2);
    const indices = rows.map((r) => r.turnIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1]);
    // No duplicate turnIndex.
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('turn_index is independent of createdAt (Wave 48 belt-and-braces preserved)', async () => {
    const svc = makeService();
    const { manager, rows } = makeFakeManager();

    await simulateFourRowTurn(svc, manager, CONV, 0);

    // Every row has BOTH a numeric turn_index AND a Date createdAt.
    rows.forEach((r) => {
      expect(typeof r.turnIndex).toBe('number');
      expect(r.createdAt).toBeInstanceOf(Date);
    });
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

    await simulateFourRowTurn(svc, manager, CONV, 0);

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
