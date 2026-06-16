/**
 * Wave wave-ai-knowledge-hub — BE-01 (2026-06-12).
 *
 * Drift detector + acceptance specs for the knowledge-map read API.
 *
 * 1. Registry ⇄ map BIJECTION (§17.15.2(a) / task §7): every name in
 *    `KNOWLEDGE_DOMAINS[].toolNames` exists in `EXECUTIVE_TOOL_NAMES`,
 *    and every registry tool maps to EXACTLY one domain. A future tool
 *    wave that adds a tool without extending `derived-domain-map.ts`
 *    fails HERE, loudly, instead of silently dropping the tool from
 *    the mind-map.
 * 2. Role gate (task §7; 2026-06-16 super-admin-only narrowing):
 *    super-admin only → 200; everyone else (user / staff / admin /
 *    c-level) → 403 — executed against the REAL controller metadata via
 *    the canonical `RolesGuard`.
 * 3. Zero-write proof (§17.15.6 / §18.13 condition 2): the map code
 *    path never touches a mutating repository method.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { EXECUTIVE_TOOL_NAMES } from '../../ai-executive-chat/tools/tool-registry';
import { SUPER_ADMIN_ONLY } from '../../auth/role-groups';
import { ROLES_KEY } from '../../auth/roles.decorator';
import { Role } from '../../auth/roles.enum';
import { RolesGuard } from '../../auth/roles.guard';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { WorkStatusApprovedGuard } from '../../auth/work-status-approved.guard';
import { AiKnowledgeHubController } from '../ai-knowledge-hub.controller';
import {
  AiKnowledgeHubService,
  KNOWLEDGE_MAP_CENTER_LABEL,
} from '../ai-knowledge-hub.service';
import {
  ALL_KNOWLEDGE_DOMAIN_KEYS,
  COVERAGE_GAPS,
  CURATED_DOMAIN_KEYS,
  CURATED_DOMAINS,
  KNOWLEDGE_DOMAIN_EDITABLE_BY,
  KNOWLEDGE_DOMAINS,
} from '../registry/derived-domain-map';

// ────────────────────────────────────────────────────────────────────
// 1. Drift detector — registry ⇄ derived-domain-map bijection
// ────────────────────────────────────────────────────────────────────

describe('derived-domain-map — registry bijection (drift detector)', () => {
  const mappedToolNames = KNOWLEDGE_DOMAINS.flatMap((domain) => [
    ...domain.toolNames,
  ]);

  // BE-04 (2026-06-12): 7 locked report-§1.2 domains + the
  // `knowledge-hub` meta-domain backing `searchKnowledgeBase` (task §7
  // — bijection preserved for the widened registry).
  it('declares the 7 locked derived domains (report §1.2) + the BE-04 knowledge-hub meta-domain', () => {
    expect(KNOWLEDGE_DOMAINS).toHaveLength(8);
    expect(KNOWLEDGE_DOMAINS.every((d) => d.layer === 'derived')).toBe(true);
  });

  it('maps searchKnowledgeBase to the dedicated knowledge-hub meta-domain (BE-04)', () => {
    const knowledgeHub = KNOWLEDGE_DOMAINS.find(
      (d) => d.key === 'knowledge-hub',
    );
    expect(knowledgeHub).toBeDefined();
    expect([...(knowledgeHub?.toolNames ?? [])]).toEqual([
      'searchKnowledgeBase',
    ]);
  });

  it('every mapped tool name exists in EXECUTIVE_TOOL_NAMES', () => {
    const registered = new Set<string>(EXECUTIVE_TOOL_NAMES);
    const unknown = mappedToolNames.filter((name) => !registered.has(name));
    expect(unknown).toEqual([]);
  });

  it('every registry tool is mapped to EXACTLY one domain', () => {
    const occurrences = new Map<string, number>();
    for (const name of mappedToolNames) {
      occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
    }

    const unmapped = EXECUTIVE_TOOL_NAMES.filter(
      (name) => (occurrences.get(name) ?? 0) === 0,
    );
    const duplicated = [...occurrences.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);

    // A failure here means a tool wave touched EXECUTIVE_TOOL_REGISTRY
    // without updating registry/derived-domain-map.ts — extend the map
    // (and FE-01 inherits the node automatically via BE-01).
    expect(unmapped).toEqual([]);
    expect(duplicated).toEqual([]);
    expect(mappedToolNames).toHaveLength(EXECUTIVE_TOOL_NAMES.length);
  });

  it('domain keys are unique across derived + curated layers', () => {
    expect(new Set(ALL_KNOWLEDGE_DOMAIN_KEYS).size).toBe(
      ALL_KNOWLEDGE_DOMAIN_KEYS.length,
    );
  });

  it('curated domains carry no backing tools and matching key list', () => {
    expect(CURATED_DOMAINS.every((d) => d.layer === 'curated')).toBe(true);
    expect(CURATED_DOMAINS.every((d) => d.toolNames.length === 0)).toBe(true);
    expect(CURATED_DOMAIN_KEYS).toEqual(CURATED_DOMAINS.map((d) => d.key));
  });

  it('exports the equipment coverage gap (Q1) without key collision', () => {
    const equipment = COVERAGE_GAPS.find((gap) => gap.key === 'equipment');
    expect(equipment).toBeDefined();
    expect(equipment?.labelTh).toBe('ครุภัณฑ์');
    expect(equipment?.reason).toBe('no executive tool registered');
    // Gap nodes must never shadow a real domain node.
    for (const gap of COVERAGE_GAPS) {
      expect(ALL_KNOWLEDGE_DOMAIN_KEYS).not.toContain(gap.key);
    }
  });

  it('editableBy is locked to admin + super-admin (Q2)', () => {
    expect([...KNOWLEDGE_DOMAIN_EDITABLE_BY]).toEqual([
      'admin',
      'super-admin',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Role gate — real controller metadata through the canonical guard
// ────────────────────────────────────────────────────────────────────

describe('GET /v1/ai-knowledge-hub/map — role gate (super-admin only, 2026-06-16 narrowing)', () => {
  const handler = AiKnowledgeHubController.prototype.getKnowledgeMap;
  const guard = new RolesGuard(new Reflector());

  const contextForRole = (role: string): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => AiKnowledgeHubController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    }) as unknown as ExecutionContext;

  it('declares @Roles(...SUPER_ADMIN_ONLY) on the map handler (2026-06-16 super-admin-only narrowing)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
      ...SUPER_ADMIN_ONLY,
    ]);
  });

  it('mirrors the chat-controller guard chain (Jwt → Roles → WorkStatus)', () => {
    // GUARDS_METADATA — '__guards__' is Nest's @UseGuards storage key.
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([
      JwtAuthGuard,
      RolesGuard,
      WorkStatusApprovedGuard,
    ]);
  });

  it('only "super-admin" passes the role gate (→ 200 path) (2026-06-16 super-admin-only narrowing)', () => {
    expect(guard.canActivate(contextForRole(Role.SUPER_ADMIN))).toBe(true);
  });

  it.each([Role.USER, Role.STAFF, Role.ADMIN, Role.C_LEVEL])(
    'role "%s" is rejected with 403 FORBIDDEN_ROLE (super-admin only)',
    (role) => {
      expect(() => guard.canActivate(contextForRole(role))).toThrow(
        ForbiddenException,
      );
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// 3. Service — zero-write proof + projection assembly
// ────────────────────────────────────────────────────────────────────

const MUTATION_METHODS = [
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'softDelete',
  'softRemove',
  'remove',
  'restore',
  'increment',
  'decrement',
  'clear',
  'query',
] as const;

interface ReadOnlyRepoStub {
  repo: Record<string, jest.Mock>;
  mutationSpies: jest.Mock[];
}

/**
 * Repository stub whose query builders resolve queued raw results and
 * whose mutating surface throws on touch — the §18.13 zero-write
 * tripwire.
 */
function createReadOnlyRepoStub(rawResultQueue: unknown[][]): ReadOnlyRepoStub {
  const queue = [...rawResultQueue];
  const mutationSpies: jest.Mock[] = [];

  const createQueryBuilder = jest.fn(() => {
    const rows = queue.shift() ?? [];
    const qb: Record<string, jest.Mock> = {};
    for (const chainable of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'groupBy',
      'addGroupBy',
      'withDeleted',
    ]) {
      qb[chainable] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn(async () => rows);
    return qb;
  });

  const repo: Record<string, jest.Mock> = { createQueryBuilder };
  for (const method of MUTATION_METHODS) {
    const spy = jest.fn(() => {
      throw new Error(
        `ZERO-WRITE VIOLATION: repository.${method}() called from the map read path (§17.15.6 / §18.13)`,
      );
    });
    repo[method] = spy;
    mutationSpies.push(spy);
  }
  return { repo, mutationSpies };
}

/**
 * BE-02 constructor deps (revision repo / work-history repo / audit
 * service) — UNUSED by the map read path; the audit stub throws on
 * touch so any future drift of the map path into a mutation fails
 * loudly (same tripwire spirit as the repo stubs above).
 */
function createInertCrudDeps() {
  return {
    revisionRepo: createReadOnlyRepoStub([]).repo,
    workHistoryRepo: { findOne: jest.fn() },
    auditService: {
      record: jest.fn(() => {
        throw new Error(
          'ZERO-WRITE VIOLATION: audit write from the map read path (§17.15.6 / §18.13)',
        );
      }),
    },
  };
}

describe('AiKnowledgeHubService.getKnowledgeMap — zero-write read aggregator', () => {
  it('assembles counts/freshness/source data without any write call', async () => {
    const entryStub = createReadOnlyRepoStub([
      // call #1 — grouped (domain_key, status) counts
      [
        { domainKey: 'budget', status: 'published', count: '3' },
        { domainKey: 'budget', status: 'draft', count: '1' },
        { domainKey: 'glossary', status: 'published', count: '2' },
        // archived rows are not surfaced in curatedCounts
        { domainKey: 'budget', status: 'archived', count: '7' },
        // unknown domain keys never crash the projection
        { domainKey: 'not-a-domain', status: 'published', count: '9' },
      ],
      // call #2 — MAX(updated_at) per domain
      [{ domainKey: 'budget', lastUpdatedAt: new Date('2026-06-12T01:02:03Z') }],
    ]);
    const sourceStub = createReadOnlyRepoStub([
      [{ domainKey: 'budget', count: '2' }],
    ]);
    const crudDeps = createInertCrudDeps();

    const service = new AiKnowledgeHubService(
      entryStub.repo as never,
      crudDeps.revisionRepo as never,
      crudDeps.workHistoryRepo as never,
      crudDeps.auditService as never,
      null as never,
      sourceStub.repo as never,
    );
    const map = await service.getKnowledgeMap();

    expect(map.centerLabel).toBe(KNOWLEDGE_MAP_CENTER_LABEL);
    expect(typeof map.asOf).toBe('string');
    expect(map.domains).toHaveLength(
      KNOWLEDGE_DOMAINS.length + CURATED_DOMAINS.length,
    );
    // BE-01 structure-mgmt wave: gaps now carry additive overlay fields
    // (`displayOrder` / `isHidden`). With an EMPTY overlay (this stub
    // passes no domain-meta repo → null → pure code fallback), each code
    // gap keeps its key/labelTh/reason verbatim and the additive fields
    // take their safe defaults (code-declaration order + visible). The
    // RENDER is byte-identical to pre-wave; only the additive
    // display-fields are new (report §4.2 overlay-not-replacement).
    expect(map.coverageGaps).toEqual(
      COVERAGE_GAPS.map((gap, index) => ({
        ...gap,
        displayOrder: index,
        isHidden: false,
      })),
    );

    const budget = map.domains.find((d) => d.key === 'budget');
    expect(budget?.layer).toBe('derived');
    expect(budget?.curatedCounts).toEqual({ published: 3, draft: 1 });
    expect(budget?.externalSourceCount).toBe(2);
    expect(budget?.lastUpdatedAt).toBe('2026-06-12T01:02:03.000Z');
    expect(budget?.editableBy).toEqual(['admin', 'super-admin']);
    // Tool metadata is projected verbatim from the frozen registry.
    expect(budget?.tools.map((t) => t.name)).toEqual([
      'getBudgetSummaryByPlan',
      'highlightBudgetOutliers',
    ]);
    expect(
      budget?.tools.every(
        (t) => t.thaiLabel.length > 0 && t.description.length > 0,
      ),
    ).toBe(true);

    const glossary = map.domains.find((d) => d.key === 'glossary');
    expect(glossary?.layer).toBe('curated');
    expect(glossary?.tools).toEqual([]);
    expect(glossary?.curatedCounts).toEqual({ published: 2, draft: 0 });
    expect(glossary?.lastUpdatedAt).toBeNull();

    const untouched = map.domains.find((d) => d.key === 'projects');
    expect(untouched?.curatedCounts).toEqual({ published: 0, draft: 0 });
    expect(untouched?.externalSourceCount).toBe(0);
    expect(untouched?.lastUpdatedAt).toBeNull();

    // ZERO-write proof — no mutating repository method was invoked.
    for (const spy of [
      ...entryStub.mutationSpies,
      ...sourceStub.mutationSpies,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('returns 200-shaped zeros on an empty database (task §8 edge case)', async () => {
    const entryStub = createReadOnlyRepoStub([[], []]);
    const sourceStub = createReadOnlyRepoStub([[]]);
    const crudDeps = createInertCrudDeps();

    const service = new AiKnowledgeHubService(
      entryStub.repo as never,
      crudDeps.revisionRepo as never,
      crudDeps.workHistoryRepo as never,
      crudDeps.auditService as never,
      null as never,
      sourceStub.repo as never,
    );
    const map = await service.getKnowledgeMap();

    expect(map.domains).toHaveLength(
      KNOWLEDGE_DOMAINS.length + CURATED_DOMAINS.length,
    );
    expect(
      map.domains.every(
        (d) =>
          d.curatedCounts.published === 0 &&
          d.curatedCounts.draft === 0 &&
          d.externalSourceCount === 0 &&
          d.lastUpdatedAt === null,
      ),
    ).toBe(true);
  });

  it('degrades externalSourceCount to 0 when the source repository is absent', async () => {
    const entryStub = createReadOnlyRepoStub([[], []]);
    const crudDeps = createInertCrudDeps();

    const service = new AiKnowledgeHubService(
      entryStub.repo as never,
      crudDeps.revisionRepo as never,
      crudDeps.workHistoryRepo as never,
      crudDeps.auditService as never,
      null as never,
      null,
    );
    const map = await service.getKnowledgeMap();

    expect(map.domains.every((d) => d.externalSourceCount === 0)).toBe(true);
  });
});
