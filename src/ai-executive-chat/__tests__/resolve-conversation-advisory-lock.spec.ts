/**
 * BE-W50-02 — resolveConversation advisory-lock concurrency guard.
 *
 * Closes RCA §2.6 G14: when two concurrent sends with
 * `conversationId === undefined` land from the same owner, only ONE
 * conversation row must be inserted.
 *
 * Contract under test:
 *   - The `id === undefined` branch is wrapped in
 *     `dataSource.transaction(...)`.
 *   - Inside the transaction, a raw `SELECT pg_advisory_xact_lock(...)`
 *     is issued BEFORE the re-check + create (serialises same-owner
 *     concurrent sends; auto-releases on commit/rollback).
 *   - Lock key is derived from `owner_work_history_id`, so DIFFERENT
 *     owners acquire DIFFERENT keys and never block each other.
 *   - After the lock, a recency re-query is performed; if a freshly-
 *     created "บทสนทนาใหม่" row exists for this owner within the last
 *     2 s, it is reused rather than inserting a duplicate.
 *
 * CLAUDE.md references:
 *   - §17.2 advisory — this lock is integrity-only, not a workflow gate.
 *   - §17.3 audit separation — no tracking_status, no FK.
 *   - §17.11 no role exemption — applies uniformly.
 *
 * Scaffolding strategy:
 *   We inject a fake DataSource that (a) serialises concurrent
 *   transactions per owner key (so the in-test simulated lock matches
 *   Postgres' real behaviour) and (b) records every `pg_advisory_xact_lock`
 *   call for inspection. The conversation "table" is an in-memory array
 *   on the fake DataSource.
 */
import { AiExecutiveChatService } from '../ai-executive-chat.service';
import { AiExecutiveConversation } from '../entities/ai-executive-conversation.entity';

// ───────────────────────────────────────────────────────────────────
// Fake DataSource / EntityManager
// ───────────────────────────────────────────────────────────────────

interface LockCall {
  sql: string;
  params: unknown[];
  ownerWhId: string;
  lockKey: string;
}

/**
 * Build a fake DataSource that:
 *   - Stores conversations in an in-memory array (shared with the
 *     outer `conversationRepo` so the `id`-provided branch is
 *     untouched; we only exercise the undefined branch here).
 *   - Exposes a `transaction(cb)` that issues a per-(owner → lock-key)
 *     mutex. Calls with the same lockKey SERIALISE; calls with
 *     different lockKeys run in parallel. Mirrors Postgres
 *     `pg_advisory_xact_lock` semantics per task spec.
 *   - Records every advisory-lock invocation so we can grep the calls
 *     and assert the lock was actually acquired.
 */
function makeFakeDataSource() {
  const conversations: AiExecutiveConversation[] = [];
  const lockCalls: LockCall[] = [];
  // lockKey -> Promise chain tail
  const lockChains = new Map<string, Promise<void>>();

  function getRepository(_entity: unknown) {
    return {
      create(payload: Partial<AiExecutiveConversation>) {
        return { ...payload } as AiExecutiveConversation;
      },
      async save(row: AiExecutiveConversation) {
        const saved: AiExecutiveConversation = {
          ...row,
          id: row.id ?? `conv-${conversations.length + 1}`,
          createdAt: row.createdAt ?? new Date(),
          updatedAt: row.updatedAt ?? null,
          deletedAt: row.deletedAt ?? null,
        } as AiExecutiveConversation;
        conversations.push(saved);
        return saved;
      },
      createQueryBuilder(_alias: string) {
        let whId: string | undefined;
        let title: string | undefined;
        let cutoff: Date | undefined;
        const qb: Record<string, unknown> = {};
        qb.where = (_s: string, p: Record<string, unknown>) => {
          if (p.whId !== undefined) whId = p.whId as string;
          return qb;
        };
        qb.andWhere = (_s: string, p?: Record<string, unknown>) => {
          if (p?.whId !== undefined) whId = p.whId as string;
          if (p?.title !== undefined) title = p.title as string;
          if (p?.cutoff !== undefined) cutoff = p.cutoff as Date;
          return qb;
        };
        qb.orderBy = () => qb;
        qb.limit = () => qb;
        qb.getOne = async () => {
          const rows = conversations
            .filter(
              (c) =>
                c.ownerWorkHistoryId === whId &&
                c.deletedAt === null &&
                (title === undefined || c.title === title) &&
                (cutoff === undefined || c.createdAt >= cutoff),
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return rows[0] ?? null;
        };
        return qb;
      },
    };
  }

  function makeManager(lockKey: { value: string | null }) {
    return {
      getRepository,
      async query(sql: string, params: unknown[]): Promise<unknown> {
        // Only the advisory-lock query is exercised here.
        expect(sql).toContain('pg_advisory_xact_lock');
        expect(sql).toContain('hashtextextended');
        const whId = String(params[0]);
        const key = `advisory:${whId}`;
        lockKey.value = key;
        lockCalls.push({
          sql,
          params,
          ownerWhId: whId,
          lockKey: key,
        });
        return [];
      },
    };
  }

  const dataSource = {
    async transaction<T>(
      cb: (manager: ReturnType<typeof makeManager>) => Promise<T>,
    ): Promise<T> {
      const lockKey = { value: null as string | null };
      const manager = makeManager(lockKey);

      // The transaction callback will call `manager.query(...)` first
      // (advisory lock), THEN proceed with the repository work. We
      // serialise the post-lock-acquisition work by key: once the key
      // is known, we chain onto the per-key tail.
      //
      // Two-phase strategy:
      //   Phase 1 — run up to the advisory-lock call, capturing the key.
      //   Phase 2 — queue the remainder behind the per-key tail.
      //
      // In practice the lock happens inside `cb`, so we instrument
      // `manager.query` to BLOCK until it's this caller's turn on the
      // per-key chain.
      const originalQuery = manager.query.bind(manager);
      let released: (() => void) | null = null;
      manager.query = async (sql: string, params: unknown[]) => {
        const result = await originalQuery(sql, params);
        // Take our turn on the per-key chain.
        const key = lockKey.value!;
        const prevTail = lockChains.get(key) ?? Promise.resolve();
        const ourTail = new Promise<void>((resolve) => {
          released = resolve;
        });
        lockChains.set(
          key,
          prevTail.then(() => ourTail),
        );
        await prevTail;
        return result;
      };

      try {
        return await cb(manager);
      } finally {
        if (released) (released as () => void)();
      }
    },
  };

  return { dataSource, conversations, lockCalls };
}

function makeSvc(ds: { transaction: unknown }): AiExecutiveChatService {
  const noop = {} as unknown;
  const conversationRepo = {
    // id-provided branch is out of scope for this spec; a findOne stub
    // that is never expected to be called prevents accidental reuse.
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  return new AiExecutiveChatService(
    ds as never, // DataSource
    conversationRepo as never, // conversationRepo
    noop as never, // messageRepo
    noop as never, // WorkHistory repo
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
  );
}

// Cast helper — `resolveConversation` is private; reach through the
// instance for white-box testing, matching the idiom used in
// hydration-ordering.spec.ts.
function callResolve(
  svc: AiExecutiveChatService,
  id: string | undefined,
  ownerWhId: string,
): Promise<AiExecutiveConversation> {
  return (
    svc as unknown as {
      resolveConversation: (
        id: string | undefined,
        ownerWhId: string,
      ) => Promise<AiExecutiveConversation>;
    }
  ).resolveConversation(id, ownerWhId);
}

// ───────────────────────────────────────────────────────────────────
// Specs
// ───────────────────────────────────────────────────────────────────

describe('BE-W50-02 / resolveConversation advisory lock (G14)', () => {
  it('two concurrent undefined-id sends from the SAME owner create exactly ONE conversation', async () => {
    const { dataSource, conversations, lockCalls } = makeFakeDataSource();
    const svc = makeSvc(dataSource);
    const OWNER_WH = 'wh-same-owner-001';

    const [r1, r2] = await Promise.all([
      callResolve(svc, undefined, OWNER_WH),
      callResolve(svc, undefined, OWNER_WH),
    ]);

    // Exactly ONE row exists at the end.
    expect(conversations).toHaveLength(1);
    // Both callers received the SAME row (the second observes the
    // post-lock recency re-query and reuses the row the first inserted).
    expect(r1.id).toBe(r2.id);
    expect(r1.ownerWorkHistoryId).toBe(OWNER_WH);
    // Both invocations DID acquire the advisory lock.
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls.every((c) => c.ownerWhId === OWNER_WH)).toBe(true);
    expect(lockCalls.every((c) => c.lockKey === `advisory:${OWNER_WH}`)).toBe(
      true,
    );
  });

  it('deterministic over 10 iterations — always exactly one row', async () => {
    const OWNER_WH = 'wh-loop-owner-001';
    for (let i = 0; i < 10; i++) {
      const { dataSource, conversations } = makeFakeDataSource();
      const svc = makeSvc(dataSource);
      const [a, b] = await Promise.all([
        callResolve(svc, undefined, OWNER_WH),
        callResolve(svc, undefined, OWNER_WH),
      ]);
      expect(conversations).toHaveLength(1);
      expect(a.id).toBe(b.id);
    }
  });

  it('two concurrent undefined-id sends from DIFFERENT owners each create their own conversation (different lock keys, no blocking)', async () => {
    const { dataSource, conversations, lockCalls } = makeFakeDataSource();
    const svc = makeSvc(dataSource);
    const OWNER_A = 'wh-owner-A';
    const OWNER_B = 'wh-owner-B';

    const [rA, rB] = await Promise.all([
      callResolve(svc, undefined, OWNER_A),
      callResolve(svc, undefined, OWNER_B),
    ]);

    // Both owners got their own fresh row.
    expect(conversations).toHaveLength(2);
    expect(rA.ownerWorkHistoryId).toBe(OWNER_A);
    expect(rB.ownerWorkHistoryId).toBe(OWNER_B);
    expect(rA.id).not.toBe(rB.id);

    // Each owner acquired their OWN lock key; keys are distinct.
    expect(lockCalls).toHaveLength(2);
    const keys = new Set(lockCalls.map((c) => c.lockKey));
    expect(keys.size).toBe(2);
    expect(keys.has(`advisory:${OWNER_A}`)).toBe(true);
    expect(keys.has(`advisory:${OWNER_B}`)).toBe(true);
  });

  it('advisory lock SQL uses pg_advisory_xact_lock with hashtextextended keyed on owner_work_history_id', async () => {
    const { dataSource, lockCalls } = makeFakeDataSource();
    const svc = makeSvc(dataSource);
    await callResolve(svc, undefined, 'wh-sql-shape-001');

    expect(lockCalls).toHaveLength(1);
    const call = lockCalls[0];
    expect(call.sql).toMatch(/pg_advisory_xact_lock\s*\(/);
    expect(call.sql).toMatch(/hashtextextended\s*\(\s*\$1::text\s*,\s*0\s*\)/);
    expect(call.params).toEqual(['wh-sql-shape-001']);
  });
});
