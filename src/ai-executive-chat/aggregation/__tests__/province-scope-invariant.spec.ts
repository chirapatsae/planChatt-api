/**
 * W55-QA-01 — Province-scope invariant spec.
 *
 * CTO audit GAP-6 (docs/reports/wave54/SEC-CONTEXT-AUDIT.md):
 *   A future commit could accidentally inject caller-context scoping into
 *   `UnifiedProjectAggregator.listUnifiedProjects` (e.g. adding an
 *   `AND wh_amp.id = :callerAmphoe` predicate derived from the caller's
 *   WorkHistory). That would silently break the Province-level aggregation
 *   contract for PAO executives by narrowing their result set to their own
 *   amphoe / LAO / agency.
 *
 * Invariant asserted here (CRITICAL):
 *   Absent an explicit opt-in DSL flag, the aggregator MUST NOT emit any
 *   WHERE predicate or bind-parameter derived from the caller's
 *   WorkHistory. The ONLY references to `wh_amp.id` / `wh_lao.id` are
 *   allowed in two positions:
 *     1. The SELECT-list projection that BE-07 added to derive
 *        `originType` (`.addSelect('wh_amp.id', 'creator_amphoe_id')`).
 *     2. The WHERE predicate emitted by the explicit opt-in DSL filter
 *        `filters.originType` — and ONLY with the two static sentinels
 *        `'3001'` / `'3001027'` from CLAUDE.md §1, NEVER with a caller-
 *        derived bind value.
 *
 * Strategy:
 *   Reuse the QB-stub approach from `unified-project-aggregator.spec.ts`.
 *   The stub records every `where` / `andWhere` clause and every bind-
 *   parameter name. With no DSL filters the bind map MUST contain zero
 *   forbidden `caller*` / `currentWorkHistory*` keys and zero WHERE
 *   predicate referencing `wh_amp.id` / `wh_lao.id`. With explicit opt-in
 *   filters the bind map contains the known DSL keys only.
 *
 * Tamper-test protocol (documented — NOT executed automatically):
 *   To verify RED-goes-RED, temporarily add
 *     `qb.andWhere('wh_amp.id = :callerAmphoe', { callerAmphoe: '3105' })`
 *   to `loadMain`. The `"no caller-amphoe bind param"` case below will
 *   fail because the bind map grows a `callerAmphoe` key; the
 *   `"no caller-derived WHERE predicate"` case will also fail because
 *   `wh_amp.id` now appears on the LHS of an equality predicate.
 *   Revert after confirmation.
 *
 * Notes:
 *   §17.2 advisory — this spec introduces zero workflow writes and zero
 *   tracking_status mutations. §17.3 — zero new `ai_*` FKs. The only
 *   mutation is in-memory instantiation of the aggregator with a stubbed
 *   DataSource.
 */
import { UnifiedProjectAggregator } from '../services/unified-project-aggregator.service';

// ─────────────────────────────────────────────────────────────────────
// Minimal QB stub — mirrors the captured-state shape used by
// `unified-project-aggregator.spec.ts` and `origin-type.spec.ts`.
// ─────────────────────────────────────────────────────────────────────

interface StubCall {
  repositoryName: string;
  whereChain: string[];
  /** Aggregated bind-parameter map across where / andWhere. */
  params: Record<string, unknown>;
}

function makeDataSource(rowsByRepo: Record<string, unknown[]> = {}): {
  dataSource: unknown;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];

  function qbFactory(repositoryName: string) {
    const call: StubCall = {
      repositoryName,
      whereChain: [],
      params: {},
    };
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      innerJoin: self,
      leftJoin: self,
      select: self,
      addSelect: self,
      where: (clause: string, params?: Record<string, unknown>) => {
        call.whereChain.push(clause);
        if (params) Object.assign(call.params, params);
        return qb;
      },
      andWhere: (clause: string, params?: Record<string, unknown>) => {
        call.whereChain.push(clause);
        if (params) Object.assign(call.params, params);
        return qb;
      },
      orderBy: self,
      limit: self,
      getRawMany: async () => {
        calls.push(call);
        return rowsByRepo[repositoryName] ?? [];
      },
    });
    return qb;
  }

  const dataSource = {
    getRepository: (target: unknown) => {
      const name =
        typeof target === 'function'
          ? ((target as { name?: string }).name ?? 'Unknown')
          : 'Unknown';
      return {
        createQueryBuilder: (_alias: string) => qbFactory(name),
      };
    },
    getMetadata: () => ({ tableName: 'budget' }),
  };
  return { dataSource, calls };
}

function svc(ds: unknown): UnifiedProjectAggregator {
  return new UnifiedProjectAggregator(ds as never);
}

// ─────────────────────────────────────────────────────────────────────
// Forbidden-pattern catalog. Any bind-param key matching these regexes
// is treated as evidence of caller-context injection. These names are
// intentionally verbose — a real-world regression would almost certainly
// reach for one of them.
// ─────────────────────────────────────────────────────────────────────

const FORBIDDEN_BIND_KEY_PATTERNS: RegExp[] = [
  /^caller/i,
  /^currentWorkHistory/i,
  /^current_work_history/i,
  /^actor(Amphoe|Lao|Agency)/i,
  /^requester(Amphoe|Lao|Agency)/i,
  /^myAmphoe/i,
  /^myLao/i,
  /^myAgency/i,
  /^scopedAmphoe/i,
  /^scopedLao/i,
  /^scopedAgency/i,
];

/**
 * Returns the list of WHERE clauses that REFERENCE a caller-context
 * alias (`wh_amp.id` / `wh_lao.id`) on the LEFT-HAND side of an
 * equality/inequality predicate.
 *
 * Excludes:
 *   - The `originType='agency-normal'` filter, which uses the static
 *     sentinels `:originAgencyAmphoeId` / `:originAgencyLaoId` — those
 *     are server-hardcoded constants, not caller-derived.
 *   - The `originType='lao-coordinated'` filter, which binds the same
 *     sentinels.
 *
 * This is a semantic check, not a textual one. A clause is considered
 * "caller-derived" if it references `wh_amp.id` or `wh_lao.id` AND binds
 * a parameter whose name is NOT `originAgencyAmphoeId` /
 * `originAgencyLaoId`.
 */
function findCallerDerivedPredicates(
  whereChain: string[],
  params: Record<string, unknown>,
): string[] {
  const offenders: string[] = [];
  const bindNames = Object.keys(params);
  for (const clause of whereChain) {
    if (!/wh_amp\.id|wh_lao\.id/.test(clause)) continue;
    // Extract bind names referenced in this clause (tokens like `:foo`).
    const refs = clause.match(/:(\w+)/g) ?? [];
    const refNames = refs.map((r) => r.slice(1));
    const allReferenced = refNames.every((name) => bindNames.includes(name));
    if (!allReferenced) continue; // defensive — only score bound refs
    const nonSentinel = refNames.some(
      (name) => name !== 'originAgencyAmphoeId' && name !== 'originAgencyLaoId',
    );
    if (nonSentinel) offenders.push(clause);
  }
  return offenders;
}

// ─────────────────────────────────────────────────────────────────────

describe('W55-QA-01 / Province-scope invariant (GAP-6)', () => {
  describe('no caller-context leakage (default call path)', () => {
    it('does not bind any `caller*` / `currentWorkHistory*` parameter (main scope)', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        limit: 10,
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      for (const key of Object.keys(mainCall!.params)) {
        for (const pat of FORBIDDEN_BIND_KEY_PATTERNS) {
          expect({ key, pattern: pat.source, matched: pat.test(key) }).toEqual({
            key,
            pattern: pat.source,
            matched: false,
          });
        }
      }
    });

    it('does not bind any caller param across all three kinds when scope=all', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
        RevisedProjectGroup: [],
        SupplementProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['all'],
        limit: 30,
      });
      expect(calls).toHaveLength(3);
      for (const c of calls) {
        for (const key of Object.keys(c.params)) {
          for (const pat of FORBIDDEN_BIND_KEY_PATTERNS) {
            expect({
              repo: c.repositoryName,
              key,
              matched: pat.test(key),
            }).toEqual({ repo: c.repositoryName, key, matched: false });
          }
        }
      }
    });

    it('emits no WHERE predicate that references wh_amp.id / wh_lao.id with a caller-derived bind (main)', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        limit: 10,
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      const offenders = findCallerDerivedPredicates(
        mainCall!.whereChain,
        mainCall!.params,
      );
      expect(offenders).toEqual([]);
    });

    it('emits no WHERE predicate referencing wh_amp.id / wh_lao.id at all when no originType filter is set (main)', async () => {
      // Stronger assertion: in the default path, the creator-chain LEFT
      // JOIN is projected into the SELECT list only. There is no reason
      // for `wh_amp.id` or `wh_lao.id` to appear on the LHS of any WHERE
      // clause. Adding such a predicate — caller-derived OR otherwise —
      // would indicate scope leakage.
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        limit: 10,
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      const referencedInWhere = mainCall!.whereChain.filter((w) =>
        /wh_amp\.id|wh_lao\.id/.test(w),
      );
      expect(referencedInWhere).toEqual([]);
    });

    it('same assertion for revised scope', async () => {
      const { dataSource, calls } = makeDataSource({
        RevisedProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['revised'],
        limit: 10,
      });
      const revisedCall = calls.find(
        (c) => c.repositoryName === 'RevisedProjectGroup',
      );
      expect(revisedCall).toBeDefined();
      const referencedInWhere = revisedCall!.whereChain.filter((w) =>
        /wh_amp\.id|wh_lao\.id/.test(w),
      );
      expect(referencedInWhere).toEqual([]);
    });

    it('same assertion for supplement scope', async () => {
      const { dataSource, calls } = makeDataSource({
        SupplementProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['supplement'],
        limit: 10,
      });
      const spgCall = calls.find(
        (c) => c.repositoryName === 'SupplementProjectGroup',
      );
      expect(spgCall).toBeDefined();
      const referencedInWhere = spgCall!.whereChain.filter((w) =>
        /wh_amp\.id|wh_lao\.id/.test(w),
      );
      expect(referencedInWhere).toEqual([]);
    });

    it('explicit filters (amphoeIds, status) do NOT pull in any caller-context bind', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        limit: 10,
        filters: {
          amphoeIds: ['3105', '3106'],
          status: ['Approved'],
        },
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      // The explicit filter MUST be present.
      expect(mainCall!.params.amphoeIdsFilter).toEqual(['3105', '3106']);
      // Caller bind keys MUST still be absent.
      for (const key of Object.keys(mainCall!.params)) {
        for (const pat of FORBIDDEN_BIND_KEY_PATTERNS) {
          expect({ key, matched: pat.test(key) }).toEqual({
            key,
            matched: false,
          });
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Positive-case sanity: explicit opt-in filters WORK. These prove the
  // invariant above is not over-eager — the aggregator CAN narrow
  // results when the DSL asks for it, which is exactly the contract.
  // ──────────────────────────────────────────────────────────────────
  describe('explicit opt-in filters (sanity — not over-eager)', () => {
    it('filters.amphoeIds binds `amphoeIdsFilter` with the exact user-requested values', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { amphoeIds: ['3105'] },
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      expect(mainCall!.params.amphoeIdsFilter).toEqual(['3105']);
      expect(
        mainCall!.whereChain.some((w) =>
          w.includes('pg.amphoe_id IN (:...amphoeIdsFilter)'),
        ),
      ).toBe(true);
    });

    it('filters.originType=agency-normal binds the STATIC sentinels (not caller-derived)', async () => {
      // W55-BE-07 — the opt-in originType filter is the only path that
      // references `wh_amp.id` / `wh_lao.id` in a WHERE predicate. The
      // bound values MUST be the server-hardcoded `'3001'` / `'3001027'`
      // sentinels from CLAUDE.md §1 — never values derived from the
      // caller's WorkHistory.
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { originType: ['agency-normal'] },
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      expect(mainCall!.params.originAgencyAmphoeId).toBe('3001');
      expect(mainCall!.params.originAgencyLaoId).toBe('3001027');
      // The predicate DOES reference wh_amp.id / wh_lao.id — but only
      // with sentinel binds. The offenders list (non-sentinel only) must
      // still be empty.
      const offenders = findCallerDerivedPredicates(
        mainCall!.whereChain,
        mainCall!.params,
      );
      expect(offenders).toEqual([]);
    });

    it('filters.agencyIds binds `agencyIdsFilter` with user-requested values only', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { agencyIds: ['42', '77'] },
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      expect(mainCall!.params.agencyIdsFilter).toEqual([42, 77]);
      for (const key of Object.keys(mainCall!.params)) {
        for (const pat of FORBIDDEN_BIND_KEY_PATTERNS) {
          expect({ key, matched: pat.test(key) }).toEqual({
            key,
            matched: false,
          });
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Interface-level invariant: the aggregator's query type MUST NOT
  // introduce a `callerAmphoe` / `callerLao` / `callerAgency` field. A
  // future refactor adding such a field would be a structural signal
  // that caller-scope is being considered — block at type level here.
  //
  // We assert by attempting to pass an object with that key and
  // expecting the TS surface to reject it at compile time. Because Jest
  // does not type-check the DSL at runtime, the assertion is that the
  // aggregator IGNORES any unknown field (no predicate emitted).
  // ──────────────────────────────────────────────────────────────────
  describe('unknown caller-shaped fields are ignored at runtime', () => {
    it('aggregator ignores unrecognised `callerAmphoe` / `callerLao` keys (no predicate emitted)', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      // Cast to `never` — the interface forbids these fields; we check
      // the defensive runtime behavior in case a future DTO deserializer
      // lets one slip through.
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        limit: 10,
        callerAmphoe: '3105',
        callerLao: '3001015',
        callerAgency: 42,
      } as never);
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      // No WHERE predicate referencing caller-scope IDs.
      const referencedInWhere = mainCall!.whereChain.filter((w) =>
        /wh_amp\.id|wh_lao\.id/.test(w),
      );
      expect(referencedInWhere).toEqual([]);
      // No bind params carrying the caller field names.
      expect(mainCall!.params.callerAmphoe).toBeUndefined();
      expect(mainCall!.params.callerLao).toBeUndefined();
      expect(mainCall!.params.callerAgency).toBeUndefined();
    });
  });
});
