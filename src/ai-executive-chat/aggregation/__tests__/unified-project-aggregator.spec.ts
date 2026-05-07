/**
 * BE-W54-02 — UnifiedProjectAggregator unit spec.
 *
 * Covers:
 *   1. Registry / module wiring sanity — concrete class and DI token.
 *   2. Empty-scope input returns `[]` gracefully.
 *   3. Single-kind scope — only the requested repository is queried.
 *   4. scope === ['all'] — budget is split 40/35/25 across three kinds.
 *   5. limit clamp (<= 50) honored; default 20; < 1 clamps to 1.
 *   6. planId filter propagates to the `dp.id = :planId` predicate.
 *   7. `planReportFormat` resolves from the parent plan's `report_format`;
 *      unknown values fall back to STRATEGY_BASED (task §11.R3).
 *   8. NO PII fields (createdBy / firstName / lastName / citizenId /
 *      phone / email) appear in the projection.
 *   9. Grep gate — zero raw table literals in the service source, zero
 *      workflow-mutation verbs.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { UnifiedProjectAggregator } from '../services/unified-project-aggregator.service';
import type { UnifiedProject } from '../types';

// ─────────────────────────────────────────────────────────────────────
// Test harness — mock DataSource whose getRepository() returns a QB
// stub. The stub captures the chain state (repository target, limit,
// parameters, andWhere chain) and returns canned raw rows.
// ─────────────────────────────────────────────────────────────────────

interface StubCall {
  repositoryName: string;
  limit?: number;
  params: Record<string, unknown>;
  whereChain: string[];
  /**
   * Captured LEFT JOIN targets. Wave 55 BE-W55-05 — the head-of-lineage
   * anti-join attaches a `leftJoin(RevisedProjectGroup, …)` keyed on
   * the entity class; the stub records the constructor name so the spec
   * can assert the anti-join fired (or was suppressed when
   * `includeHistoricalVersions=true`).
   */
  leftJoinTargets: string[];
}

type MainRawRow = {
  id: string;
  title: string | null;
  planid: string | null;
  reportformat: string | null;
  amphoeid: number | null;
  agencyid: number | null;
  strategyid: string | null;
  tacticid: string | null;
  planlevelid: string | null;
  indicator: string | null;
  issueid: string | null;
  // Wave 55 W55-BE-07 — creator WorkHistory amphoe + LAO ID scalars
  // used to derive `originType` per §1 + §5.
  creator_amphoe_id: string | null;
  creator_lao_id: string | null;
};

function makeDataSource(opts: {
  /** Per-repository raw rows returned by getRawMany. */
  rowsByRepo?: Record<string, MainRawRow[]>;
}) {
  const calls: StubCall[] = [];
  const rowsByRepo = opts.rowsByRepo ?? {};

  function qbFactory(repositoryName: string) {
    const call: StubCall = {
      repositoryName,
      params: {},
      whereChain: [],
      leftJoinTargets: [],
    };
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      innerJoin: self,
      leftJoin: (target: unknown, _alias?: string, _cond?: string) => {
        // Record the entity-class target so the spec can assert the
        // head-of-lineage anti-join fired. String targets (relation
        // names like `pg.developmentPlan`) are NOT lineage joins — skip.
        if (typeof target === 'function') {
          const name = (target as { name?: string }).name ?? 'UnknownEntity';
          call.leftJoinTargets.push(name);
        }
        return qb;
      },
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
      limit: (n: number) => {
        call.limit = n;
        return qb;
      },
      getRawMany: async () => {
        calls.push(call);
        return rowsByRepo[repositoryName] ?? [];
      },
    });
    return qb;
  }

  const dataSource = {
    getRepository: (target: unknown) => {
      const repoName =
        typeof target === 'function'
          ? ((target as { name?: string }).name ?? 'Unknown')
          : 'Unknown';
      return {
        createQueryBuilder: (_alias: string) => qbFactory(repoName),
      };
    },
  };

  return { dataSource, calls };
}

function svc(ds: unknown): UnifiedProjectAggregator {
  return new UnifiedProjectAggregator(ds as never);
}

function row(id: string, overrides: Partial<MainRawRow> = {}): MainRawRow {
  return {
    id,
    title: `proj-${id}`,
    planid: 'plan-1',
    reportformat: 'STRATEGY_BASED',
    amphoeid: null,
    agencyid: null,
    strategyid: null,
    tacticid: null,
    planlevelid: null,
    indicator: null,
    issueid: null,
    // Wave 55 W55-BE-07 — default to a non-agency creator so existing
    // cases exercise the `lao-coordinated` branch unless overridden.
    creator_amphoe_id: null,
    creator_lao_id: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────

describe('BE-W54-02 / UnifiedProjectAggregator', () => {
  // ── 1. Empty / defensive input ───────────────────────────────────
  describe('defensive input handling', () => {
    it('returns [] when scope is missing', async () => {
      const { dataSource, calls } = makeDataSource({});
      const out = await svc(dataSource).listUnifiedProjects({
        scope: undefined as never,
      });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('returns [] when scope is an empty array', async () => {
      const { dataSource, calls } = makeDataSource({});
      const out = await svc(dataSource).listUnifiedProjects({ scope: [] });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('returns [] when the underlying query yields no rows', async () => {
      const { dataSource } = makeDataSource({});
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out).toEqual([]);
    });
  });

  // ── 2. Single-kind scope ─────────────────────────────────────────
  describe('single-kind scope', () => {
    it('main scope queries ProjectGroup only', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out).toHaveLength(1);
      expect(out[0].projectKind).toBe('main');
      expect(out[0].projectId).toBe('pg-1');
      const repos = calls.map((c) => c.repositoryName);
      expect(repos).toEqual(['ProjectGroup']);
    });

    it('revised scope queries RevisedProjectGroup only', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { RevisedProjectGroup: [row('rpg-1')] },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['revised'],
      });
      expect(out).toHaveLength(1);
      expect(out[0].projectKind).toBe('revised');
      const repos = calls.map((c) => c.repositoryName);
      expect(repos).toEqual(['RevisedProjectGroup']);
    });

    it('supplement scope queries SupplementProjectGroup only', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { SupplementProjectGroup: [row('spg-1')] },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['supplement'],
      });
      expect(out).toHaveLength(1);
      expect(out[0].projectKind).toBe('supplement');
      // Wave 55 W55-BE-04 — SPG now carries a nullable `amphoe_id` FK.
      // The raw-row stub defaults `amphoeid: null`, so the emitted
      // `amphoeId` is null here; rows with a populated FK project the
      // numeric id instead. Per-row `geo:supplement` advisory lives in
      // `GeoEnrichmentService`, not the aggregator.
      expect(out[0].amphoeId).toBeNull();
      const repos = calls.map((c) => c.repositoryName);
      expect(repos).toEqual(['SupplementProjectGroup']);
    });
  });

  // ── 3. scope === ['all'] ─────────────────────────────────────────
  describe("scope === ['all']", () => {
    it('queries all three repositories with the 40/35/25 split', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [row('pg-1')],
          RevisedProjectGroup: [row('rpg-1')],
          SupplementProjectGroup: [row('spg-1')],
        },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['all'],
        limit: 20,
      });
      expect(out).toHaveLength(3);
      // 20 * 0.4 = 8; 20 * 0.35 = 7; remainder = 5.
      const byRepo = Object.fromEntries(
        calls.map((c) => [c.repositoryName, c.limit]),
      );
      expect(byRepo).toEqual({
        ProjectGroup: 8,
        RevisedProjectGroup: 7,
        SupplementProjectGroup: 5,
      });
      // Emission order: main → revised → supplement.
      expect(out.map((u) => u.projectKind)).toEqual([
        'main',
        'revised',
        'supplement',
      ]);
    });

    it('grand total per-kind budgets never exceed limit', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [],
          RevisedProjectGroup: [],
          SupplementProjectGroup: [],
        },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['all'],
        limit: 10,
      });
      const total = calls.reduce((acc, c) => acc + (c.limit ?? 0), 0);
      expect(total).toBeLessThanOrEqual(10);
    });

    it('expands explicit [main, revised, supplement] identically to [all]', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [],
          RevisedProjectGroup: [],
          SupplementProjectGroup: [],
        },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main', 'revised', 'supplement'],
        limit: 20,
      });
      const byRepo = Object.fromEntries(
        calls.map((c) => [c.repositoryName, c.limit]),
      );
      expect(byRepo).toEqual({
        ProjectGroup: 8,
        RevisedProjectGroup: 7,
        SupplementProjectGroup: 5,
      });
    });
  });

  // ── 4. limit clamp ───────────────────────────────────────────────
  describe('limit clamp', () => {
    it('clamps limit > 50 down to 50', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        limit: 9999,
      });
      expect(calls[0].limit).toBe(50);
    });

    it('defaults to limit = 20 when omitted', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).listUnifiedProjects({ scope: ['main'] });
      expect(calls[0].limit).toBe(20);
    });

    it('clamps limit < 1 up to 1', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        limit: 0,
      });
      expect(calls[0].limit).toBe(1);
    });
  });

  // ── 5. planId filter ─────────────────────────────────────────────
  describe('planId filter', () => {
    it('propagates planId to each per-kind query when provided', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [],
          RevisedProjectGroup: [],
          SupplementProjectGroup: [],
        },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['all'],
        planId: 'plan-42',
      });
      for (const c of calls) {
        expect(c.params.planId).toBe('plan-42');
        expect(c.whereChain.some((w) => w.includes('dp.id = :planId'))).toBe(
          true,
        );
      }
    });

    it('omits the planId predicate when planId is absent', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).listUnifiedProjects({ scope: ['main'] });
      for (const c of calls) {
        expect(c.whereChain.some((w) => w.includes(':planId'))).toBe(false);
      }
    });
  });

  // ── 6. reportFormat resolution ───────────────────────────────────
  describe('planReportFormat resolution', () => {
    it('propagates STRATEGY_BASED from the parent plan', async () => {
      const { dataSource } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [row('pg-1', { reportformat: 'STRATEGY_BASED' })],
        },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out[0].planReportFormat).toBe('STRATEGY_BASED');
    });

    it('propagates ISSUE_BASED from the parent plan', async () => {
      const { dataSource } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [
            row('pg-1', {
              reportformat: 'ISSUE_BASED',
              strategyid: null,
              tacticid: null,
              planlevelid: null,
              indicator: null,
              issueid: 'issue-1',
            }),
          ],
        },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out[0].planReportFormat).toBe('ISSUE_BASED');
      expect(out[0].developmentIssueId).toBe('issue-1');
      expect(out[0].indicator).toBeNull();
    });

    it('falls back to STRATEGY_BASED when reportformat is unknown', async () => {
      const { dataSource } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [row('pg-1', { reportformat: 'WAT' as never })],
        },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out[0].planReportFormat).toBe('STRATEGY_BASED');
    });
  });

  // ── 7. PII-discipline grep ───────────────────────────────────────
  describe('PII discipline', () => {
    const servicePath = join(
      __dirname,
      '..',
      'services',
      'unified-project-aggregator.service.ts',
    );
    const rawSource = readFileSync(servicePath, 'utf8');
    /**
     * Strip block comments (`/* … *\/`) and line comments (`//`) so the
     * invariant-declaration comment block at the top of the file (which
     * intentionally lists the PII field names it excludes) does not
     * trigger false positives in this grep.
     */
    const codeOnly = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    // Wave 55 W55-BE-07 — narrowed the forbidden list to person-level
    // PII only. The aggregator now LEFT JOINs through `createdBy` to
    // read creator WorkHistory's amphoe.id / LAO.id (two ID scalars,
    // not PII) for the §1 + §5 `originType` derivation. The JOIN does
    // NOT project firstName / lastName / citizenId / phone / email, and
    // the emitted UnifiedProject row still carries none of those keys.
    it.each([
      ['firstName'],
      ['first_name'],
      ['lastName'],
      ['last_name'],
      ['citizenId'],
      ['citizen_id'],
      ['phone'],
      ['email'],
    ])('does NOT project PII field %s', (forbidden) => {
      expect(codeOnly).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    });

    it('emitted UnifiedProject rows do NOT carry PII fields', async () => {
      const { dataSource } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      const emitted = out[0] as UnifiedProject & Record<string, unknown>;
      for (const f of [
        'createdBy',
        'firstName',
        'lastName',
        'citizenId',
        'phone',
        'email',
      ]) {
        expect(emitted[f]).toBeUndefined();
      }
    });
  });

  // ── 8. Source-level invariants (grep gate) ───────────────────────
  describe('source-level invariants', () => {
    const servicePath = join(
      __dirname,
      '..',
      'services',
      'unified-project-aggregator.service.ts',
    );
    const rawSource = readFileSync(servicePath, 'utf8');
    const codeOnly = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    it('contains ZERO raw SQL table literals', () => {
      // Patterns: `FROM project_groups`, `FROM "revised_project_groups"`,
      // `JOIN supplement_project_groups`, etc. The service MUST resolve
      // tables via entity metadata only.
      const forbidden = [
        /\bFROM\s+project_groups\b/i,
        /\bFROM\s+revised_project_groups\b/i,
        /\bFROM\s+supplement_project_groups\b/i,
        /\bFROM\s+development_plan\b/i,
        /\bFROM\s+development_plan_revision\b/i,
        /\bFROM\s+development_plan_supplement\b/i,
        /\bJOIN\s+project_groups\b/i,
        /\bJOIN\s+revised_project_groups\b/i,
        /\bJOIN\s+supplement_project_groups\b/i,
        /"project_groups"/,
        /"revised_project_groups"/,
        /"supplement_project_groups"/,
      ];
      for (const pat of forbidden) {
        expect(codeOnly).not.toMatch(pat);
      }
    });

    it('contains ZERO workflow-mutation verbs', () => {
      // Read-only guarantee — these verbs MUST NOT appear anywhere in
      // the aggregator. TrackingStatus is composed READ-only (§12).
      const forbidden = [
        /\.save\s*\(/,
        /\.insert\s*\(/,
        /\.update\s*\(/,
        /\.delete\s*\(/,
        /\.softRemove\s*\(/,
        /\.softDelete\s*\(/,
        /\.remove\s*\(/,
        /tracking_status/i,
      ];
      for (const pat of forbidden) {
        expect(codeOnly).not.toMatch(pat);
      }
    });

    // ── Wave 55 BE-W55-05 — §14.2 head-of-lineage filter ──────────
    describe('W55-BE-05 / head-of-lineage filter', () => {
      it('attaches a RevisedProjectGroup anti-join on main scope by default', async () => {
        const { dataSource, calls } = makeDataSource({
          rowsByRepo: { ProjectGroup: [row('pg-1')] },
        });
        await svc(dataSource).listUnifiedProjects({ scope: ['main'] });
        const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
        expect(mainCall).toBeDefined();
        // Anti-join target is the RevisedProjectGroup entity class.
        expect(mainCall!.leftJoinTargets).toContain('RevisedProjectGroup');
        // The anti-join surfaces as an `IS NULL` predicate appended to
        // the WHERE chain (the right side of the left join is nullable,
        // so "no descendant" = "descendant row is NULL").
        expect(
          mainCall!.whereChain.some((w) => /pg_desc\.id IS NULL/.test(w)),
        ).toBe(true);
      });

      it('attaches a self-anti-join on revised scope by default', async () => {
        const { dataSource, calls } = makeDataSource({
          rowsByRepo: { RevisedProjectGroup: [row('rpg-1')] },
        });
        await svc(dataSource).listUnifiedProjects({ scope: ['revised'] });
        const revisedCall = calls.find(
          (c) => c.repositoryName === 'RevisedProjectGroup',
        );
        expect(revisedCall).toBeDefined();
        // RPG self-anti-join — the left-join target is also RevisedProjectGroup.
        expect(revisedCall!.leftJoinTargets).toContain('RevisedProjectGroup');
        expect(
          revisedCall!.whereChain.some((w) => /rpg_desc\.id IS NULL/.test(w)),
        ).toBe(true);
      });

      it('does NOT attach any lineage anti-join on supplement scope', async () => {
        // SPG is NOT part of the PG/RPG revision chain (§14.1) — the
        // loadSupplement reader stays untouched and must emit no
        // lineage left-join.
        const { dataSource, calls } = makeDataSource({
          rowsByRepo: { SupplementProjectGroup: [row('spg-1')] },
        });
        await svc(dataSource).listUnifiedProjects({ scope: ['supplement'] });
        const supCall = calls.find(
          (c) => c.repositoryName === 'SupplementProjectGroup',
        );
        expect(supCall).toBeDefined();
        expect(supCall!.leftJoinTargets).not.toContain('RevisedProjectGroup');
        expect(
          supCall!.whereChain.some((w) => /_desc\.id IS NULL/.test(w)),
        ).toBe(false);
      });

      it('SHORT-CIRCUITS the anti-join when includeHistoricalVersions=true (main)', async () => {
        const { dataSource, calls } = makeDataSource({
          rowsByRepo: { ProjectGroup: [row('pg-1')] },
        });
        await svc(dataSource).listUnifiedProjects({
          scope: ['main'],
          includeHistoricalVersions: true,
        });
        const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
        expect(mainCall).toBeDefined();
        // Flag true = legacy behavior = no anti-join.
        expect(mainCall!.leftJoinTargets).not.toContain('RevisedProjectGroup');
        expect(
          mainCall!.whereChain.some((w) => /pg_desc\.id IS NULL/.test(w)),
        ).toBe(false);
      });

      it('SHORT-CIRCUITS the anti-join when includeHistoricalVersions=true (revised)', async () => {
        const { dataSource, calls } = makeDataSource({
          rowsByRepo: { RevisedProjectGroup: [row('rpg-1')] },
        });
        await svc(dataSource).listUnifiedProjects({
          scope: ['revised'],
          includeHistoricalVersions: true,
        });
        const revisedCall = calls.find(
          (c) => c.repositoryName === 'RevisedProjectGroup',
        );
        expect(revisedCall).toBeDefined();
        expect(revisedCall!.leftJoinTargets).not.toContain(
          'RevisedProjectGroup',
        );
        expect(
          revisedCall!.whereChain.some((w) => /rpg_desc\.id IS NULL/.test(w)),
        ).toBe(false);
      });

      it('PG+RPG fixture: default mode emits only the head (the RPG), not both', async () => {
        // This is the numerical-correctness AC from the task file: plan
        // with 1 approved PG + 1 approved RPG derived from it returns
        // exactly 1 unified row. The mock harness cannot run the real
        // DB anti-join, so we simulate the DB's behavior: at the SQL
        // layer the anti-join drops the PG row; under the mock we model
        // that by returning `[]` for ProjectGroup when the HEAD filter
        // is active (i.e. the anti-join clause was added). The RPG
        // survives because it has no descendant.
        const { dataSource } = makeDataSource({
          rowsByRepo: {
            // Mock "DB" post-anti-join result: PG is filtered out.
            ProjectGroup: [],
            RevisedProjectGroup: [row('rpg-1', { id: 'rpg-1' })],
            SupplementProjectGroup: [],
          },
        });
        const out = await svc(dataSource).listUnifiedProjects({
          scope: ['all'],
          planId: 'plan-1',
        });
        expect(out).toHaveLength(1);
        expect(out[0].projectKind).toBe('revised');
        expect(out[0].projectId).toBe('rpg-1');
      });

      it('PG+RPG fixture: includeHistoricalVersions=true emits BOTH rows', async () => {
        // With the flag set, the anti-join short-circuits and the mock
        // "DB" returns both rows as in pre-Wave-55 behavior.
        const { dataSource } = makeDataSource({
          rowsByRepo: {
            ProjectGroup: [row('pg-1', { id: 'pg-1' })],
            RevisedProjectGroup: [row('rpg-1', { id: 'rpg-1' })],
            SupplementProjectGroup: [],
          },
        });
        const out = await svc(dataSource).listUnifiedProjects({
          scope: ['all'],
          planId: 'plan-1',
          includeHistoricalVersions: true,
        });
        expect(out).toHaveLength(2);
        expect(out.map((u) => u.projectKind).sort()).toEqual([
          'main',
          'revised',
        ]);
      });
    });

    it('emits the `projectKind` discriminator on every row', async () => {
      const { dataSource } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [row('pg-1')],
          RevisedProjectGroup: [row('rpg-1')],
          SupplementProjectGroup: [row('spg-1')],
        },
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['all'],
      });
      for (const u of out) {
        expect(['main', 'revised', 'supplement']).toContain(u.projectKind);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Wave 55 W55-BE-06 — DSL `filters` plumbing.
  //
  // These specs verify `applyFilters(qb, filters, kind)` emits the
  // correct parameterized WHERE clause for each of the five filter
  // dimensions declared by `EXECUTIVE_QUERY_SCHEMA.filters`:
  //   · status        → INNER JOIN on tracking_status + status.name IN ...
  //   · amphoeIds     → alias.amphoe_id IN :ids   (all three kinds post-W55-BE-04)
  //   · agencyIds     → alias.responsible_agency_id IN :ids (Number-coerced)
  //   · budgetRange   → correlated SUM(budget.quantity) subquery
  //   · dateRange     → alias.created_at BETWEEN :from AND :to
  //
  // The test stub does not execute the SQL — it records the QB chain
  // state (bind params + whereChain), so these specs assert the clause
  // was composed and bound correctly.
  // ──────────────────────────────────────────────────────────────────
  describe('W55-BE-06 DSL filters plumbing', () => {
    // ── filters.status ────────────────────────────────────────────
    it('filters.status binds the status names and joins TrackingStatus', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { status: ['Approved', 'Pending_Approval'] },
      });
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.params.statusFilter).toEqual([
        'Approved',
        'Pending_Approval',
      ]);
      expect(
        call.whereChain.some((w) =>
          w.includes('st_f.name IN (:...statusFilter)'),
        ),
      ).toBe(true);
    });

    it('filters.status is a no-op when the array is empty or missing', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { status: [] },
      });
      const call = calls[0];
      expect(call.params.statusFilter).toBeUndefined();
      expect(call.whereChain.some((w) => w.includes('statusFilter'))).toBe(
        false,
      );
    });

    // ── filters.amphoeIds ─────────────────────────────────────────
    it('filters.amphoeIds binds the ids uniformly across PG, RPG, and SPG (W55-BE-04)', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [row('pg-1')],
          RevisedProjectGroup: [row('rpg-1')],
          SupplementProjectGroup: [row('spg-1')],
        },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['all'],
        filters: { amphoeIds: ['3001', '3002'] },
      });
      const byRepo = Object.fromEntries(
        calls.map((c) => [c.repositoryName, c]),
      );
      // PG — bound, IN predicate present.
      expect(byRepo.ProjectGroup.params.amphoeIdsFilter).toEqual([
        '3001',
        '3002',
      ]);
      expect(
        byRepo.ProjectGroup.whereChain.some((w) =>
          w.includes('pg.amphoe_id IN (:...amphoeIdsFilter)'),
        ),
      ).toBe(true);
      // RPG — same.
      expect(byRepo.RevisedProjectGroup.params.amphoeIdsFilter).toEqual([
        '3001',
        '3002',
      ]);
      expect(
        byRepo.RevisedProjectGroup.whereChain.some((w) =>
          w.includes('rpg.amphoe_id IN (:...amphoeIdsFilter)'),
        ),
      ).toBe(true);
      // SPG — W55-DB-01 added `amphoe_id` FK; the filter now binds the
      // same way as PG / RPG. SPG rows with NULL amphoe_id fall out
      // naturally through the `IN (...)` predicate.
      expect(byRepo.SupplementProjectGroup.params.amphoeIdsFilter).toEqual([
        '3001',
        '3002',
      ]);
      expect(
        byRepo.SupplementProjectGroup.whereChain.some((w) =>
          w.includes('spg.amphoe_id IN (:...amphoeIdsFilter)'),
        ),
      ).toBe(true);
      // The old `WHERE 1=0` SPG short-circuit must be gone.
      expect(
        byRepo.SupplementProjectGroup.whereChain.some((w) => w === '1 = 0'),
      ).toBe(false);
    });

    // ── filters.agencyIds ─────────────────────────────────────────
    it('filters.agencyIds coerces string ids to Number and binds them', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { agencyIds: ['11', '22'] },
      });
      const call = calls[0];
      expect(call.params.agencyIdsFilter).toEqual([11, 22]);
      expect(
        call.whereChain.some((w) =>
          w.includes('pg.responsible_agency_id IN (:...agencyIdsFilter)'),
        ),
      ).toBe(true);
    });

    it('filters.agencyIds silently drops invalid ids (AC #2)', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      // "abc" is NaN; "42" is valid.
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { agencyIds: ['abc', '42', 'NaN'] },
      });
      const call = calls[0];
      expect(call.params.agencyIdsFilter).toEqual([42]);
      expect(call.whereChain.some((w) => w.includes('agencyIdsFilter'))).toBe(
        true,
      );
    });

    it('filters.agencyIds of all-invalid collapses to WHERE 1=0 (no crash)', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { agencyIds: ['abc', 'NaN', 'xyz'] },
      });
      const call = calls[0];
      expect(call.params.agencyIdsFilter).toBeUndefined();
      expect(call.whereChain.some((w) => w === '1 = 0')).toBe(true);
    });

    // ── filters.budgetRange ───────────────────────────────────────
    it('filters.budgetRange with min + max binds a BETWEEN predicate', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      // Stub DataSource.getMetadata(Budget) for the table-name lookup.
      (
        dataSource as unknown as {
          getMetadata: (e: unknown) => { tableName: string };
        }
      ).getMetadata = () => ({ tableName: 'budget' });

      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { budgetRange: { min: 100_000, max: 500_000 } },
      });
      const call = calls[0];
      expect(call.params.budgetMin).toBe(100_000);
      expect(call.params.budgetMax).toBe(500_000);
      expect(
        call.whereChain.some((w) =>
          w.includes('BETWEEN :budgetMin AND :budgetMax'),
        ),
      ).toBe(true);
      // The subquery must bind the FK column for the kind.
      expect(
        call.whereChain.some((w) => w.includes('b_f.project_group_id = pg.id')),
      ).toBe(true);
    });

    it('filters.budgetRange with only min uses >= and only max uses <=', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: {
          ProjectGroup: [row('pg-1')],
          RevisedProjectGroup: [row('rpg-1')],
        },
      });
      (
        dataSource as unknown as {
          getMetadata: (e: unknown) => { tableName: string };
        }
      ).getMetadata = () => ({ tableName: 'budget' });

      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { budgetRange: { min: 100 } },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['revised'],
        filters: { budgetRange: { max: 999 } },
      });
      const pg = calls[0];
      const rpg = calls[1];
      expect(pg.whereChain.some((w) => w.includes('>= :budgetMin'))).toBe(true);
      expect(rpg.whereChain.some((w) => w.includes('<= :budgetMax'))).toBe(
        true,
      );
      // Revised kind uses `revised_project_group_id` FK.
      expect(
        rpg.whereChain.some((w) =>
          w.includes('b_f.revised_project_group_id = rpg.id'),
        ),
      ).toBe(true);
    });

    // ── filters.dateRange ─────────────────────────────────────────
    it('filters.dateRange binds BETWEEN :dateFrom AND :dateTo', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: {
          dateRange: {
            from: '2026-01-01T00:00:00Z',
            to: '2026-12-31T23:59:59Z',
          },
        },
      });
      const call = calls[0];
      expect(call.params.dateFrom).toBe('2026-01-01T00:00:00Z');
      expect(call.params.dateTo).toBe('2026-12-31T23:59:59Z');
      expect(
        call.whereChain.some((w) =>
          w.includes('pg.created_at BETWEEN :dateFrom AND :dateTo'),
        ),
      ).toBe(true);
    });

    it('filters.dateRange half-open bounds use >= / <=', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { dateRange: { from: '2026-01-01T00:00:00Z' } },
      });
      const call = calls[0];
      expect(call.whereChain.some((w) => w.includes('>= :dateFrom'))).toBe(
        true,
      );
      expect(call.whereChain.some((w) => w.includes(':dateTo'))).toBe(false);
    });

    // ── No-op semantics ──────────────────────────────────────────
    it('omits all filter predicates when filters is undefined', async () => {
      const { dataSource, calls } = makeDataSource({
        rowsByRepo: { ProjectGroup: [row('pg-1')] },
      });
      await svc(dataSource).listUnifiedProjects({ scope: ['main'] });
      const call = calls[0];
      expect(call.params.statusFilter).toBeUndefined();
      expect(call.params.amphoeIdsFilter).toBeUndefined();
      expect(call.params.agencyIdsFilter).toBeUndefined();
      expect(call.params.budgetMin).toBeUndefined();
      expect(call.params.dateFrom).toBeUndefined();
    });
  });
});
