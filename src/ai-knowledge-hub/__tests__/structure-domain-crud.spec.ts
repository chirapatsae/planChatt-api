/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-02 (2026-06-13).
 *
 * Class-A domain display-overlay + coverage-gap CRUD acceptance specs
 * (task §6 / §7):
 *
 *  1. Role matrix (Q-03) — Class-A mutations are admin + super-admin
 *     ONLY through the canonical `RolesGuard` against REAL controller
 *     metadata: `user` / `staff` / `c-level` → 403; `admin` /
 *     `super-admin` → pass. `GET /structure` stays EXEC_READ.
 *  2. Domain overlay upsert — INSERT when absent, merge-patch UPDATE when
 *     present; label / description / order / colour / icon / hidden flow
 *     through; an edit survives "reboot" (the overlay row persists; the
 *     idempotent seed never reverts it).
 *  3. Derived-no-add/delete guard (Q-05) — unknown `domainKey` →
 *     `400 KNOWLEDGE_DOMAIN_UNKNOWN`; the controller exposes NO domain
 *     create / delete route and the PATCH DTO omits `key` / `layer` /
 *     tool binding (they cannot be sent).
 *  4. Token allow-list — an off-list colour / icon →
 *     `400 KNOWLEDGE_TOKEN_INVALID`.
 *  5. Coverage-gap CRUD — create rejects a key colliding with a code
 *     domain / code gap / existing row (`400 KNOWLEDGE_GAP_KEY_COLLISION`);
 *     a UI gap soft-deletes; a CODE gap (`equipment`) hides instead.
 *  6. Audit (§17.3) — every mutation writes EXACTLY ONE
 *     `ai_knowledge_audit_logs` row (actor WorkHistory uuid + denormalized
 *     role) on the caller's transactional manager; NEVER TrackingStatus.
 *  7. Bulk reorder — stamps known keys, ignores stale keys, writes ONE
 *     batch audit row.
 *  8. Hygiene — no tracking-status / project-table import anywhere in the
 *     module (grep-style spec).
 */
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { ADMIN_OR_ABOVE, EXEC_READ } from '../../auth/role-groups';
import { ROLES_KEY } from '../../auth/roles.decorator';
import { Role } from '../../auth/roles.enum';
import { RolesGuard } from '../../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../../auth/work-status-approved.guard';
import { KnowledgeStructureController } from '../controllers/knowledge-structure.controller';
import {
  KNOWLEDGE_COLOR_TOKENS,
  KNOWLEDGE_ICON_KEYS,
} from '../constants/structure-tokens';
import { AiKnowledgeAuditLog } from '../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeDomainMeta } from '../entities/ai-knowledge-domain-meta.entity';
import { COVERAGE_GAPS } from '../registry/derived-domain-map';
import { KnowledgeAuditService } from '../services/knowledge-audit.service';
import { KnowledgeStructureService } from '../services/knowledge-structure.service';

// ────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const exception = caught as HttpException;
  expect(exception.getStatus()).toBe(status);
  const response = exception.getResponse();
  if (typeof response === 'string') {
    expect(response).toBe(code);
  } else {
    const body = response as Record<string, unknown>;
    expect(body.code ?? body.message).toBe(code);
  }
}

type DomainMetaRow = Partial<AiKnowledgeDomainMeta> &
  Pick<AiKnowledgeDomainMeta, 'domainKey' | 'nodeKind'>;

interface StructureHarness {
  service: KnowledgeStructureService;
  rows: Array<Record<string, unknown>>;
  auditRows: Array<Record<string, unknown>>;
  spies: {
    transaction: jest.Mock;
    save: jest.Mock;
    softDelete: jest.Mock;
    auditInsert: jest.Mock;
  };
}

const ACTOR_WH_ID = 'wh-admin-1';

/**
 * In-memory harness over the BE-02 write path. The REAL
 * `KnowledgeAuditService` is wired in (its base repository THROWS so the
 * spec proves every audit row joins the caller's transactional manager —
 * §17.3 atomicity). The `domain_meta` store enforces the UNIQUE
 * `domain_key` constraint conceptually via key lookups.
 */
function createStructureHarness(
  seed: DomainMetaRow[] = [],
  options: { actorRole?: string } = {},
): StructureHarness {
  const rows: Array<Record<string, unknown>> = seed.map((row, index) => ({
    id: `seed-${index}`,
    labelThOverride: null,
    labelEnOverride: null,
    descriptionTh: null,
    displayOrder: 0,
    colorToken: null,
    iconKey: null,
    isHidden: false,
    gapReasonTh: null,
    createdByWorkHistoryId: ACTOR_WH_ID,
    updatedByWorkHistoryId: ACTOR_WH_ID,
    createdAt: new Date('2026-06-13T10:00:00Z'),
    updatedAt: new Date('2026-06-13T10:00:00Z'),
    deletedAt: null,
    ...row,
  }));
  const auditRows: Array<Record<string, unknown>> = [];

  const matchWhere = (
    where: Record<string, unknown>,
    withDeleted: boolean,
  ): Record<string, unknown> | undefined =>
    rows.find((row) => {
      if (!withDeleted && row.deletedAt) return false;
      if (where.domainKey !== undefined && row.domainKey !== where.domainKey) {
        return false;
      }
      if (where.nodeKind !== undefined && row.nodeKind !== where.nodeKind) {
        return false;
      }
      return true;
    });

  const txRepo = {
    create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
    save: jest.fn(async (input: Record<string, unknown> | unknown[]) => {
      const upsertOne = (one: Record<string, unknown>) => {
        const existing = one.id
          ? rows.find((row) => row.id === one.id)
          : undefined;
        if (existing) {
          Object.assign(existing, one, { updatedAt: new Date() });
          return existing;
        }
        const created = {
          ...one,
          id: (one.id as string) ?? `row-new-${rows.length + 1}`,
          createdAt: new Date('2026-06-13T11:00:00Z'),
          updatedAt: new Date('2026-06-13T11:00:00Z'),
          deletedAt: (one.deletedAt as Date | null) ?? null,
        };
        rows.push(created);
        return created;
      };
      if (Array.isArray(input)) return input.map(upsertOne);
      return upsertOne(input);
    }),
    find: jest.fn(
      async ({ where }: { where: { domainKey?: { _value?: string[] } } }) => {
        // `In([...])` becomes a FindOperator; pull its values out.
        const op = (where?.domainKey ?? {}) as {
          _value?: string[];
          _type?: string;
        };
        const keys = op._value ?? [];
        return rows.filter(
          (row) => !row.deletedAt && keys.includes(row.domainKey as string),
        );
      },
    ),
    findOne: jest.fn(
      async ({
        where,
        withDeleted,
      }: {
        where: Record<string, unknown>;
        withDeleted?: boolean;
      }) => matchWhere(where, withDeleted ?? false) ?? null,
    ),
    softDelete: jest.fn(async (criteria: { id: string }) => {
      const row = rows.find((r) => r.id === criteria.id && !r.deletedAt);
      if (!row) return { affected: 0 };
      row.deletedAt = new Date();
      return { affected: 1 };
    }),
  };

  const txAuditRepo = {
    insert: jest.fn(async (row: Record<string, unknown>) => {
      auditRows.push({ ...row });
      return { identifiers: [] };
    }),
  };

  const entityManagerFake = {
    getRepository: (entity: unknown) => {
      if (entity === AiKnowledgeDomainMeta) return txRepo;
      if (entity === AiKnowledgeAuditLog) return txAuditRepo;
      throw new Error('unexpected repository request in transaction');
    },
  };

  const transaction = jest.fn(
    async (callback: (manager: unknown) => Promise<unknown>) =>
      callback(entityManagerFake),
  );

  const domainMetaRepoFake = {
    findOne: jest.fn(
      async ({
        where,
        withDeleted,
      }: {
        where: Record<string, unknown>;
        withDeleted?: boolean;
      }) => matchWhere(where, withDeleted ?? false) ?? null,
    ),
    manager: { transaction },
  };

  const workHistoryRepoFake = {
    findOne: jest.fn(async () => ({
      id: ACTOR_WH_ID,
      role: { name: options.actorRole ?? 'admin' },
    })),
  };

  // Base repo THROWS — proves the audit row always rides the caller's
  // transactional EntityManager (§17.3 atomicity).
  const throwingBaseAuditRepo = {
    insert: jest.fn(() => {
      throw new Error(
        'audit row written OUTSIDE the mutation transaction (§17.3 atomicity violation)',
      );
    }),
  };
  const auditService = new KnowledgeAuditService(throwingBaseAuditRepo as never);

  const service = new KnowledgeStructureService(
    domainMetaRepoFake as never,
    workHistoryRepoFake as never,
    auditService,
  );

  return {
    service,
    rows,
    auditRows,
    spies: {
      transaction,
      save: txRepo.save,
      softDelete: txRepo.softDelete,
      auditInsert: txAuditRepo.insert,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// 1. Role matrix (Q-03) — real controller metadata through RolesGuard
// ────────────────────────────────────────────────────────────────────

describe('KnowledgeStructureController — role gate (Q-03 / Q-06)', () => {
  const guard = new RolesGuard(new Reflector());

  const contextFor = (
    handler: (...args: never[]) => unknown,
    role: string,
  ): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => KnowledgeStructureController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  const MUTATION_HANDLERS: Array<[string, (...args: never[]) => unknown]> = [
    ['patchDomainOverlay', KnowledgeStructureController.prototype.patchDomainOverlay],
    ['reorderDomains', KnowledgeStructureController.prototype.reorderDomains],
    ['createGap', KnowledgeStructureController.prototype.createGap],
    ['patchGap', KnowledgeStructureController.prototype.patchGap],
    ['deleteGap', KnowledgeStructureController.prototype.deleteGap],
  ];

  it.each(MUTATION_HANDLERS)(
    '%s declares @Roles(...ADMIN_OR_ABOVE) + the canonical guard chain',
    (_name, handler) => {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        ...ADMIN_OR_ABOVE,
      ]);
      expect(Reflect.getMetadata('__guards__', handler)).toEqual([
        JwtAuthGuard,
        RolesGuard,
        WorkStatusApprovedGuard,
      ]);
    },
  );

  it.each(MUTATION_HANDLERS)(
    '%s: admin + super-admin pass; user / staff / c-level → 403',
    (_name, handler) => {
      expect(guard.canActivate(contextFor(handler, Role.ADMIN))).toBe(true);
      expect(guard.canActivate(contextFor(handler, Role.SUPER_ADMIN))).toBe(
        true,
      );
      for (const role of [Role.USER, Role.STAFF, Role.C_LEVEL]) {
        expect(() => guard.canActivate(contextFor(handler, role))).toThrow(
          ForbiddenException,
        );
      }
    },
  );

  it('GET /structure stays EXEC_READ (read audience unchanged)', () => {
    const handler = KnowledgeStructureController.prototype.getStructure;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([...EXEC_READ]);
    for (const role of [Role.STAFF, Role.C_LEVEL]) {
      expect(guard.canActivate(contextFor(handler, role))).toBe(true);
    }
    expect(() => guard.canActivate(contextFor(handler, Role.USER))).toThrow(
      ForbiddenException,
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Domain overlay upsert
// ────────────────────────────────────────────────────────────────────

describe('patchDomainOverlay — Class-A display overlay', () => {
  it('INSERTS an overlay row when none exists, with the patched fields', async () => {
    const harness = createStructureHarness();
    const result = await harness.service.patchDomainOverlay(
      'budget',
      {
        labelThOverride: 'งบประมาณ (แก้)',
        labelEnOverride: 'Budget (edited)',
        descriptionTh: 'หมวดงบประมาณ',
        displayOrder: 2,
        colorToken: 'violet',
        iconKey: 'banknote',
        isHidden: false,
      },
      'user-id',
    );

    expect(result.domainKey).toBe('budget');
    expect(result.labelThOverride).toBe('งบประมาณ (แก้)');
    expect(result.colorToken).toBe('violet');
    expect(result.iconKey).toBe('banknote');
    // Row persisted (survives "reboot" — seed never reverts an edited row).
    const stored = harness.rows.find((r) => r.domainKey === 'budget');
    expect(stored).toBeDefined();
    expect(stored?.nodeKind).toBe('domain');
    expect(stored?.createdByWorkHistoryId).toBe(ACTOR_WH_ID);
  });

  it('UPDATES (merge-patch) an existing overlay row; omitted fields unchanged', async () => {
    const harness = createStructureHarness([
      {
        domainKey: 'budget',
        nodeKind: 'domain',
        labelThOverride: 'เดิม',
        colorToken: 'sky',
        displayOrder: 1,
      },
    ]);
    const result = await harness.service.patchDomainOverlay(
      'budget',
      { labelThOverride: 'ใหม่' },
      'user-id',
    );
    expect(result.labelThOverride).toBe('ใหม่');
    // Untouched fields preserved.
    expect(result.colorToken).toBe('sky');
    expect(result.displayOrder).toBe(1);
    // No duplicate row created.
    expect(harness.rows.filter((r) => r.domainKey === 'budget')).toHaveLength(
      1,
    );
  });

  it('null explicitly CLEARS an override back to the code value', async () => {
    const harness = createStructureHarness([
      { domainKey: 'budget', nodeKind: 'domain', labelThOverride: 'เดิม' },
    ]);
    const result = await harness.service.patchDomainOverlay(
      'budget',
      { labelThOverride: null },
      'user-id',
    );
    expect(result.labelThOverride).toBeNull();
  });

  it('writes EXACTLY ONE domain_meta_update audit row on the tx manager', async () => {
    const harness = createStructureHarness();
    await harness.service.patchDomainOverlay(
      'budget',
      { displayOrder: 5 },
      'user-id',
    );
    expect(harness.auditRows).toHaveLength(1);
    const audit = harness.auditRows[0];
    expect(audit.action).toBe('domain_meta_update');
    expect(audit.targetKind).toBe('domain_meta');
    expect(audit.actorWorkHistoryId).toBe(ACTOR_WH_ID);
    expect(audit.actorRole).toBe('admin');
    expect((audit.detail as Record<string, unknown>).changedFields).toEqual([
      'displayOrder',
    ]);
    // The throwing base repo was never used → audit rode the tx manager.
    expect(harness.spies.transaction).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Derived-no-add/delete guard (Q-05) + 4. token allow-list
// ────────────────────────────────────────────────────────────────────

describe('patchDomainOverlay — guards', () => {
  it('rejects an unknown domainKey with 400 KNOWLEDGE_DOMAIN_UNKNOWN', async () => {
    const harness = createStructureHarness();
    await expectHttpError(
      harness.service.patchDomainOverlay(
        'not-a-real-domain',
        { displayOrder: 0 },
        'user-id',
      ),
      400,
      'KNOWLEDGE_DOMAIN_UNKNOWN',
    );
    // No write, no audit.
    expect(harness.spies.save).not.toHaveBeenCalled();
    expect(harness.auditRows).toHaveLength(0);
  });

  it('rejects an off-allow-list colour token with 400 KNOWLEDGE_TOKEN_INVALID', async () => {
    const harness = createStructureHarness();
    await expectHttpError(
      harness.service.patchDomainOverlay(
        'budget',
        { colorToken: 'chartreuse' },
        'user-id',
      ),
      400,
      'KNOWLEDGE_TOKEN_INVALID',
    );
    expect(harness.auditRows).toHaveLength(0);
  });

  it('rejects an off-allow-list icon key with 400 KNOWLEDGE_TOKEN_INVALID', async () => {
    const harness = createStructureHarness();
    await expectHttpError(
      harness.service.patchDomainOverlay(
        'budget',
        { iconKey: 'unicorn' },
        'user-id',
      ),
      400,
      'KNOWLEDGE_TOKEN_INVALID',
    );
  });

  it('accepts every allow-listed colour + icon token', async () => {
    for (const colorToken of KNOWLEDGE_COLOR_TOKENS) {
      const harness = createStructureHarness();
      const result = await harness.service.patchDomainOverlay(
        'budget',
        { colorToken },
        'user-id',
      );
      expect(result.colorToken).toBe(colorToken);
    }
    for (const iconKey of KNOWLEDGE_ICON_KEYS) {
      const harness = createStructureHarness();
      const result = await harness.service.patchDomainOverlay(
        'budget',
        { iconKey },
        'user-id',
      );
      expect(result.iconKey).toBe(iconKey);
    }
  });

  it('exposes NO domain create / delete route (Q-05 — derived display-only)', () => {
    const proto = KnowledgeStructureController.prototype as unknown as Record<
      string,
      unknown
    >;
    // The controller has gap create/delete + domain PATCH only — there is
    // no `createDomain` / `deleteDomain` handler anywhere.
    expect(proto.createDomain).toBeUndefined();
    expect(proto.deleteDomain).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. Coverage-gap CRUD
// ────────────────────────────────────────────────────────────────────

describe('coverage-gap CRUD', () => {
  it('creates a UI gap and audits gap_create (one row)', async () => {
    const harness = createStructureHarness();
    const result = await harness.service.createGap(
      { domainKey: 'attachments', labelTh: 'เอกสารแนบ', gapReasonTh: 'ยังไม่ทำดัชนี' },
      'user-id',
    );
    expect(result.key).toBe('attachments');
    expect(result.labelTh).toBe('เอกสารแนบ');
    expect(result.gapReasonTh).toBe('ยังไม่ทำดัชนี');
    const stored = harness.rows.find((r) => r.domainKey === 'attachments');
    expect(stored?.nodeKind).toBe('gap');
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0].action).toBe('gap_create');
    expect(harness.auditRows[0].targetKind).toBe('gap');
  });

  it('rejects a gap key colliding with a code domain key', async () => {
    const harness = createStructureHarness();
    await expectHttpError(
      harness.service.createGap({ domainKey: 'budget', labelTh: 'x' }, 'user-id'),
      400,
      'KNOWLEDGE_GAP_KEY_COLLISION',
    );
  });

  it('rejects a gap key colliding with a code gap key (equipment)', async () => {
    const harness = createStructureHarness();
    await expectHttpError(
      harness.service.createGap(
        { domainKey: 'equipment', labelTh: 'x' },
        'user-id',
      ),
      400,
      'KNOWLEDGE_GAP_KEY_COLLISION',
    );
  });

  it('rejects a gap key colliding with an existing (incl. soft-deleted) row', async () => {
    const harness = createStructureHarness([
      {
        domainKey: 'attachments',
        nodeKind: 'gap',
        deletedAt: new Date(),
      },
    ]);
    await expectHttpError(
      harness.service.createGap(
        { domainKey: 'attachments', labelTh: 'x' },
        'user-id',
      ),
      400,
      'KNOWLEDGE_GAP_KEY_COLLISION',
    );
  });

  it('patches an existing UI gap and audits gap_update', async () => {
    const harness = createStructureHarness([
      { domainKey: 'attachments', nodeKind: 'gap', labelThOverride: 'เก่า' },
    ]);
    const result = await harness.service.patchGap(
      'attachments',
      { labelTh: 'ใหม่', isHidden: true },
      'user-id',
    );
    expect(result.labelTh).toBe('ใหม่');
    expect(result.isHidden).toBe(true);
    expect(harness.auditRows[0].action).toBe('gap_update');
  });

  it('UPSERTS an overlay when patching a CODE gap with no row yet', async () => {
    const harness = createStructureHarness();
    const result = await harness.service.patchGap(
      'equipment',
      { gapReasonTh: 'ปรับเหตุผล' },
      'user-id',
    );
    expect(result.key).toBe('equipment');
    expect(result.gapReasonTh).toBe('ปรับเหตุผล');
    // Label falls back to the code gap label when not patched.
    const codeEquip = COVERAGE_GAPS.find((g) => g.key === 'equipment');
    expect(result.labelTh).toBe(codeEquip?.labelTh ?? null);
    expect((harness.auditRows[0].detail as Record<string, unknown>).created).toBe(
      true,
    );
  });

  it('404s a patch on a non-existent non-code gap key', async () => {
    const harness = createStructureHarness();
    await expectHttpError(
      harness.service.patchGap('ghost', { labelTh: 'x' }, 'user-id'),
      404,
      'KNOWLEDGE_GAP_NOT_FOUND',
    );
  });

  it('soft-deletes a UI gap with the audit row BEFORE deletedAt', async () => {
    const harness = createStructureHarness([
      { domainKey: 'attachments', nodeKind: 'gap', labelThOverride: 'x' },
    ]);
    const result = await harness.service.deleteGap('attachments', 'user-id');
    expect(result.softDeleted).toBe(true);
    expect(result.hidden).toBe(false);
    const stored = harness.rows.find((r) => r.domainKey === 'attachments');
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    // Exactly one gap_delete audit; the audit insert preceded softDelete.
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0].action).toBe('gap_delete');
    expect(harness.spies.auditInsert.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spies.softDelete.mock.invocationCallOrder[0],
    );
  });

  it('HIDES (not deletes) a CODE gap — it re-appears from code', async () => {
    const harness = createStructureHarness([
      { domainKey: 'equipment', nodeKind: 'gap', labelThOverride: 'ครุภัณฑ์' },
    ]);
    const result = await harness.service.deleteGap('equipment', 'user-id');
    expect(result.softDeleted).toBe(false);
    expect(result.hidden).toBe(true);
    expect(result.note).toContain('โค้ด');
    const stored = harness.rows.find((r) => r.domainKey === 'equipment');
    expect(stored?.isHidden).toBe(true);
    expect(stored?.deletedAt).toBeNull(); // NOT soft-deleted
    expect(harness.spies.softDelete).not.toHaveBeenCalled();
    expect(harness.auditRows[0].action).toBe('gap_delete');
  });

  it('HIDES a CODE gap by upserting an overlay when none exists', async () => {
    const harness = createStructureHarness();
    const result = await harness.service.deleteGap('equipment', 'user-id');
    expect(result.hidden).toBe(true);
    const stored = harness.rows.find((r) => r.domainKey === 'equipment');
    expect(stored?.isHidden).toBe(true);
    expect(stored?.nodeKind).toBe('gap');
  });
});

// ────────────────────────────────────────────────────────────────────
// 6. Bulk reorder
// ────────────────────────────────────────────────────────────────────

describe('reorderDomains — bulk drag-reorder', () => {
  it('stamps displayOrder by index, ignores stale keys, ONE batch audit row', async () => {
    const harness = createStructureHarness([
      { domainKey: 'budget', nodeKind: 'domain' },
      { domainKey: 'projects', nodeKind: 'domain' },
    ]);
    const result = await harness.service.reorderDomains(
      { domainKeys: ['projects', 'budget', 'ghost-key'] },
      'user-id',
    );
    expect(result.appliedOrder).toEqual(['projects', 'budget']);
    expect(result.ignoredKeys).toEqual(['ghost-key']);

    const projects = harness.rows.find((r) => r.domainKey === 'projects');
    const budget = harness.rows.find((r) => r.domainKey === 'budget');
    expect(projects?.displayOrder).toBe(0);
    expect(budget?.displayOrder).toBe(1);

    // ONE batch audit row carrying the full applied order.
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0].action).toBe('domain_meta_update');
    const detail = harness.auditRows[0].detail as Record<string, unknown>;
    expect(detail.batchReorder).toBe(true);
    expect(detail.appliedOrder).toEqual(['projects', 'budget']);
  });
});

// ────────────────────────────────────────────────────────────────────
// 7. §17.3 hygiene — no TrackingStatus / project-table import
// ────────────────────────────────────────────────────────────────────

describe('§17.3 hygiene — no TrackingStatus / project-table import (grep-style)', () => {
  // Grep-style spec scoped to IMPORT / EXPORT lines (mirrors the BE-02
  // curated-CRUD hygiene check) — prose mentions of "TrackingStatus" /
  // "project table" in the §17.3 documentation comments are NOT
  // offenders; only a real module dependency on a tracking-status /
  // project-owning entity is forbidden.
  const FILES = [
    path.resolve(__dirname, '../services/knowledge-structure.service.ts'),
    path.resolve(__dirname, '../controllers/knowledge-structure.controller.ts'),
    path.resolve(__dirname, '../dto/structure-domain.dto.ts'),
    path.resolve(__dirname, '../dto/structure-gap.dto.ts'),
    path.resolve(__dirname, '../constants/structure-tokens.ts'),
  ];

  it.each(FILES)('%s imports no tracking-status / project entity', (file) => {
    const offenders: string[] = [];
    const importLines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^\s*(import|export)\s.*from\s+['"]/.test(line));
    for (const line of importLines) {
      if (
        /tracking[-_]?status/i.test(line) ||
        /project-group|project_groups/i.test(line) ||
        /development-plan/i.test(line)
      ) {
        offenders.push(line.trim());
      }
    }
    expect(offenders).toEqual([]);
  });
});
