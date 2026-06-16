/**
 * Wave wave-ai-knowledge-hub — BE-02 (2026-06-12).
 *
 * Curated-knowledge CRUD acceptance specs (task §7):
 *
 * 1. Role matrix — every knowledge-hub endpoint (reads + mutations) is
 *    super-admin ONLY (2026-06-16 super-admin-only narrowing); user /
 *    staff / admin / c-level → 403 via the canonical `RolesGuard`
 *    against REAL controller metadata.
 * 2. §17.4 content hash — SHA-256 over NFC-normalized title + body;
 *    NFC-stable, boundary-unambiguous.
 * 3. Edit produces immutable revision vN+1, preserves vN byte-for-byte,
 *    bumps `current_version`, recomputes the hash.
 * 4. Same-content PATCH (identical hash + identical metadata) is an
 *    idempotent no-op: existing state returned, NO revision, NO audit,
 *    ZERO mutation.
 * 5. Optimistic concurrency — `currentVersion` mismatch → 409
 *    KNOWLEDGE_VERSION_CONFLICT (both pre-check and lost-race UPDATE).
 * 6. Every mutation writes EXACTLY ONE `ai_knowledge_audit_logs` row
 *    (actor WorkHistory uuid + denormalized role) — §17.3, NEVER
 *    TrackingStatus.
 * 7. Visibility — non-admin callers see `published` only.
 * 8. Hygiene — no tracking-status / project-table import anywhere in
 *    the module (grep-style spec per task §7).
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
import { SUPER_ADMIN_ONLY } from '../../auth/role-groups';
import { ROLES_KEY } from '../../auth/roles.decorator';
import { Role } from '../../auth/roles.enum';
import { RolesGuard } from '../../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../../auth/work-status-approved.guard';
import { AiKnowledgeHubController } from '../ai-knowledge-hub.controller';
import {
  AiKnowledgeHubService,
  computeKnowledgeContentHash,
} from '../ai-knowledge-hub.service';
import { AiKnowledgeAuditLog } from '../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeEntry } from '../entities/ai-knowledge-entry.entity';
import { AiKnowledgeEntryRevision } from '../entities/ai-knowledge-entry-revision.entity';
import { KnowledgeAuditService } from '../services/knowledge-audit.service';

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

interface EntryRow {
  id: string;
  domainKey: string;
  title: string;
  bodyMd: string;
  tags: string[];
  origin: 'curated' | 'external';
  sourceId: string | null;
  status: 'draft' | 'published' | 'archived';
  currentVersion: number;
  contentHash: string;
  language: string;
  classification: 'public' | 'internal';
  createdByWorkHistoryId: string;
  updatedByWorkHistoryId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const SEED_TITLE = 'เล่มเพิ่มเติม คืออะไร';
const SEED_BODY = 'เล่มเพิ่มเติม คือเล่มที่เพิ่มโครงการใหม่เข้าแผนพัฒนา';

function seedEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'entry-1',
    domainKey: 'glossary',
    title: SEED_TITLE,
    bodyMd: SEED_BODY,
    tags: ['อภิธานศัพท์'],
    origin: 'curated',
    sourceId: null,
    status: 'draft',
    currentVersion: 1,
    contentHash: computeKnowledgeContentHash(SEED_TITLE, SEED_BODY),
    language: 'th',
    classification: 'internal',
    createdByWorkHistoryId: 'wh-admin-1',
    updatedByWorkHistoryId: 'wh-admin-1',
    createdAt: new Date('2026-06-12T00:00:00Z'),
    updatedAt: new Date('2026-06-12T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

interface CrudHarness {
  service: AiKnowledgeHubService;
  entryRows: EntryRow[];
  revisionRows: Array<Record<string, unknown>>;
  auditRows: Array<Record<string, unknown>>;
  spies: {
    transaction: jest.Mock;
    revisionInsert: jest.Mock;
    auditInsert: jest.Mock;
    entryUpdate: jest.Mock;
    entrySoftDelete: jest.Mock;
  };
}

/**
 * In-memory harness over the BE-02 write path. The REAL
 * `KnowledgeAuditService` is wired in (its base repository THROWS so
 * the spec proves every audit row joins the caller's transaction).
 * The revision store enforces UNIQUE (entry_id, version).
 */
function createCrudHarness(
  seed: EntryRow[] = [],
  options: { actorRole?: string } = {},
): CrudHarness {
  const entryRows: EntryRow[] = seed.map((row) => ({ ...row }));
  const revisionRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];

  const findLiveEntry = (id: string): EntryRow | null =>
    entryRows.find((row) => row.id === id && !row.deletedAt) ?? null;

  const txEntryRepo = {
    create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
    save: jest.fn(async (input: Record<string, unknown>) => {
      const row = {
        ...input,
        id: (input.id as string) ?? `entry-new-${entryRows.length + 1}`,
        createdAt: new Date('2026-06-12T10:00:00Z'),
        updatedAt: new Date('2026-06-12T10:00:00Z'),
        deletedAt: null,
      } as EntryRow;
      entryRows.push(row);
      return row;
    }),
    update: jest.fn(
      async (
        criteria: { id: string; currentVersion?: number },
        patch: Record<string, unknown>,
      ) => {
        const row = entryRows.find(
          (candidate) =>
            candidate.id === criteria.id &&
            !candidate.deletedAt &&
            (criteria.currentVersion === undefined ||
              candidate.currentVersion === criteria.currentVersion),
        );
        if (!row) return { affected: 0 };
        Object.assign(row, patch, { updatedAt: new Date() });
        return { affected: 1 };
      },
    ),
    softDelete: jest.fn(async (criteria: { id: string }) => {
      const row = findLiveEntry(criteria.id);
      if (!row) return { affected: 0 };
      row.deletedAt = new Date();
      return { affected: 1 };
    }),
  };

  const txRevisionRepo = {
    insert: jest.fn(async (row: Record<string, unknown>) => {
      const duplicate = revisionRows.some(
        (existing) =>
          existing.entryId === row.entryId && existing.version === row.version,
      );
      if (duplicate) {
        // Mirrors uq_ai_knowledge_entry_revisions_entry_version.
        throw new Error('UNIQUE_VIOLATION (entry_id, version)');
      }
      revisionRows.push({
        id: `rev-${revisionRows.length + 1}`,
        createdAt: new Date('2026-06-12T10:00:00Z'),
        ...row,
      });
      return { identifiers: [] };
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
      if (entity === AiKnowledgeEntry) return txEntryRepo;
      if (entity === AiKnowledgeEntryRevision) return txRevisionRepo;
      if (entity === AiKnowledgeAuditLog) return txAuditRepo;
      throw new Error('unexpected repository request in transaction');
    },
  };

  const transaction = jest.fn(
    async (callback: (manager: unknown) => Promise<unknown>) =>
      callback(entityManagerFake),
  );

  const entryRepoFake = {
    findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
      findLiveEntry(where.id),
    ),
    manager: { transaction },
  };

  const revisionRepoFake = {
    find: jest.fn(
      async ({ where }: { where: { entryId: string } }) =>
        revisionRows
          .filter((row) => row.entryId === where.entryId)
          .sort((a, b) => (b.version as number) - (a.version as number)),
    ),
  };

  const workHistoryRepoFake = {
    findOne: jest.fn(async () => ({
      id: 'wh-admin-1',
      role: { name: options.actorRole ?? 'admin' },
    })),
  };

  // Base repository THROWS — proves the audit row always rides the
  // caller's transactional EntityManager (atomicity, task §6).
  const throwingBaseAuditRepo = {
    insert: jest.fn(() => {
      throw new Error(
        'audit row written OUTSIDE the mutation transaction (task §6 atomicity violation)',
      );
    }),
  };
  const auditService = new KnowledgeAuditService(
    throwingBaseAuditRepo as never,
  );

  const service = new AiKnowledgeHubService(
    entryRepoFake as never,
    revisionRepoFake as never,
    workHistoryRepoFake as never,
    auditService,
    // knowledgeSearchService — unused by the CRUD paths under test.
    null as never,
    null,
  );

  return {
    service,
    entryRows,
    revisionRows,
    auditRows,
    spies: {
      transaction,
      revisionInsert: txRevisionRepo.insert,
      auditInsert: txAuditRepo.insert,
      entryUpdate: txEntryRepo.update,
      entrySoftDelete: txEntryRepo.softDelete,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// 1. §17.4 content hash
// ────────────────────────────────────────────────────────────────────

describe('computeKnowledgeContentHash — §17.4 NFC SHA-256', () => {
  it('returns 64 lowercase hex chars', () => {
    const hash = computeKnowledgeContentHash(SEED_TITLE, SEED_BODY);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is NFC-stable (composed and decomposed forms hash identically)', () => {
    // U+00E9 (é composed) vs U+0065 U+0301 (e + combining acute).
    expect(computeKnowledgeContentHash('caf\u00e9', SEED_BODY)).toBe(
      computeKnowledgeContentHash('cafe\u0301', SEED_BODY),
    );
  });

  it('keeps the title/body boundary unambiguous', () => {
    expect(computeKnowledgeContentHash('ab', 'c')).not.toBe(
      computeKnowledgeContentHash('a', 'bc'),
    );
  });

  it('differs when only the body changes', () => {
    expect(computeKnowledgeContentHash(SEED_TITLE, SEED_BODY)).not.toBe(
      computeKnowledgeContentHash(SEED_TITLE, `${SEED_BODY} (แก้ไข)`),
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Role matrix — real controller metadata through the canonical guard
// ────────────────────────────────────────────────────────────────────

describe('curated-knowledge endpoints — role matrix (Q2 LOCKED)', () => {
  const proto = AiKnowledgeHubController.prototype;
  const readHandlers = [proto.listEntries, proto.getEntry] as const;
  const adminHandlers = [
    proto.listEntryRevisions,
    proto.createEntry,
    proto.updateEntry,
    proto.publishEntry,
    proto.archiveEntry,
    proto.deleteEntry,
  ] as const;
  const guard = new RolesGuard(new Reflector());

  const contextFor = (
    handler: (...args: never[]) => unknown,
    role: string,
  ): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => AiKnowledgeHubController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    }) as unknown as ExecutionContext;

  it('list/detail reads declare @Roles(...SUPER_ADMIN_ONLY) (2026-06-16 super-admin-only narrowing)', () => {
    for (const handler of readHandlers) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        ...SUPER_ADMIN_ONLY,
      ]);
    }
  });

  it('revisions + all five mutations declare @Roles(...SUPER_ADMIN_ONLY) (2026-06-16 super-admin-only narrowing)', () => {
    for (const handler of adminHandlers) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        ...SUPER_ADMIN_ONLY,
      ]);
    }
  });

  it('every entry handler mirrors the canonical guard chain (Jwt → Roles → WorkStatus)', () => {
    for (const handler of [...readHandlers, ...adminHandlers]) {
      expect(Reflect.getMetadata('__guards__', handler)).toEqual([
        JwtAuthGuard,
        RolesGuard,
        WorkStatusApprovedGuard,
      ]);
    }
  });

  it.each([Role.USER, Role.STAFF, Role.ADMIN, Role.C_LEVEL])(
    'role "%s" is rejected (403) on every mutation / revision handler (super-admin only)',
    (role) => {
      for (const handler of adminHandlers) {
        expect(() => guard.canActivate(contextFor(handler, role))).toThrow(
          ForbiddenException,
        );
      }
    },
  );

  it('only super-admin passes the role gate on every mutation handler (2026-06-16 super-admin-only narrowing)', () => {
    for (const handler of adminHandlers) {
      expect(guard.canActivate(contextFor(handler, Role.SUPER_ADMIN))).toBe(
        true,
      );
    }
  });

  it('only super-admin passes the role gate on reads (2026-06-16 super-admin-only narrowing)', () => {
    for (const handler of readHandlers) {
      expect(guard.canActivate(contextFor(handler, Role.SUPER_ADMIN))).toBe(
        true,
      );
    }
  });

  it.each([Role.USER, Role.STAFF, Role.ADMIN, Role.C_LEVEL])(
    'role "%s" is rejected (403) on reads too (super-admin only)',
    (role) => {
      for (const handler of readHandlers) {
        expect(() => guard.canActivate(contextFor(handler, role))).toThrow(
          ForbiddenException,
        );
      }
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// 3. Create
// ────────────────────────────────────────────────────────────────────

describe('createEntry — draft + revision v1 + audit (POST /entries)', () => {
  it('creates a curated draft with revision v1 and exactly one audit row', async () => {
    const harness = createCrudHarness();

    const dto = {
      domainKey: 'glossary',
      title: SEED_TITLE,
      bodyMd: SEED_BODY,
      tags: ['อภิธานศัพท์'],
    };
    const created = await harness.service.createEntry(dto as never, 'user-1');

    // Entry — draft, curated, v1, §17.4 hash, Q5/Q4 defaults.
    expect(created.status).toBe('draft');
    expect(created.origin).toBe('curated');
    expect(created.sourceId).toBeNull();
    expect(created.currentVersion).toBe(1);
    expect(created.contentHash).toBe(
      computeKnowledgeContentHash(SEED_TITLE, SEED_BODY),
    );
    expect(created.language).toBe('th');
    expect(created.classification).toBe('internal');
    expect(created.createdByWorkHistoryId).toBe('wh-admin-1');

    // Revision v1 — same content + hash.
    expect(harness.revisionRows).toHaveLength(1);
    expect(harness.revisionRows[0]).toMatchObject({
      entryId: created.id,
      version: 1,
      title: SEED_TITLE,
      bodyMd: SEED_BODY,
      contentHash: created.contentHash,
      editedByWorkHistoryId: 'wh-admin-1',
    });

    // EXACTLY ONE audit row — actor WorkHistory uuid + denormalized role.
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0]).toMatchObject({
      action: 'create',
      targetKind: 'entry',
      targetId: created.id,
      actorWorkHistoryId: 'wh-admin-1',
      actorRole: 'admin',
    });
  });

  it('rejects an unknown domainKey with 400 KNOWLEDGE_DOMAIN_UNKNOWN and writes nothing', async () => {
    const harness = createCrudHarness();

    await expectHttpError(
      harness.service.createEntry(
        {
          domainKey: 'not-a-domain',
          title: 'x',
          bodyMd: 'y',
        } as never,
        'user-1',
      ),
      400,
      'KNOWLEDGE_DOMAIN_UNKNOWN',
    );

    expect(harness.entryRows).toHaveLength(0);
    expect(harness.revisionRows).toHaveLength(0);
    expect(harness.auditRows).toHaveLength(0);
    expect(harness.spies.transaction).not.toHaveBeenCalled();
  });

  it('accepts derived domain keys too (entries may attach to any registry domain)', async () => {
    const harness = createCrudHarness();
    const created = await harness.service.createEntry(
      { domainKey: 'budget', title: 'ก', bodyMd: 'ข' } as never,
      'user-1',
    );
    expect(created.domainKey).toBe('budget');
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. Update — revision chain, idempotency, optimistic concurrency
// ────────────────────────────────────────────────────────────────────

describe('updateEntry — immutable revision vN+1 (PATCH /entries/:id)', () => {
  it('writes revision v2, bumps current_version, recomputes the hash, audits once', async () => {
    const harness = createCrudHarness([seedEntry()]);
    // Pre-existing v1 revision (as created at POST time).
    harness.revisionRows.push({
      id: 'rev-seed-1',
      entryId: 'entry-1',
      version: 1,
      title: SEED_TITLE,
      bodyMd: SEED_BODY,
      tags: ['อภิธานศัพท์'],
      contentHash: computeKnowledgeContentHash(SEED_TITLE, SEED_BODY),
      editedByWorkHistoryId: 'wh-admin-1',
      createdAt: new Date('2026-06-12T00:00:00Z'),
    });
    const v1Snapshot = JSON.stringify(harness.revisionRows[0]);

    const newBody = `${SEED_BODY} — ปรับปรุงเพิ่มเติม`;
    const updated = await harness.service.updateEntry(
      'entry-1',
      { currentVersion: 1, bodyMd: newBody } as never,
      'user-1',
    );

    expect(updated.currentVersion).toBe(2);
    expect(updated.bodyMd).toBe(newBody);
    expect(updated.contentHash).toBe(
      computeKnowledgeContentHash(SEED_TITLE, newBody),
    );

    // Revision v2 inserted; v1 preserved byte-for-byte (immutability).
    expect(harness.revisionRows).toHaveLength(2);
    const v2 = harness.revisionRows.find((row) => row.version === 2);
    expect(v2).toMatchObject({
      entryId: 'entry-1',
      title: SEED_TITLE,
      bodyMd: newBody,
      contentHash: updated.contentHash,
      editedByWorkHistoryId: 'wh-admin-1',
    });
    expect(
      JSON.stringify(harness.revisionRows.find((row) => row.version === 1)),
    ).toBe(v1Snapshot);

    // Live row reflects the bump.
    expect(harness.entryRows[0].currentVersion).toBe(2);
    expect(harness.entryRows[0].bodyMd).toBe(newBody);

    // Exactly one audit row with the version diff.
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0]).toMatchObject({
      action: 'update',
      targetKind: 'entry',
      targetId: 'entry-1',
      actorWorkHistoryId: 'wh-admin-1',
      actorRole: 'admin',
      detail: expect.objectContaining({ fromVersion: 1, toVersion: 2 }),
    });
  });

  it('same-content PATCH (identical hash) is an idempotent no-op: existing state, NO revision, NO audit', async () => {
    const harness = createCrudHarness([seedEntry()]);

    const result = await harness.service.updateEntry(
      'entry-1',
      {
        currentVersion: 1,
        title: SEED_TITLE,
        bodyMd: SEED_BODY,
        tags: ['อภิธานศัพท์'],
      } as never,
      'user-1',
    );

    expect(result.currentVersion).toBe(1);
    expect(result.contentHash).toBe(
      computeKnowledgeContentHash(SEED_TITLE, SEED_BODY),
    );
    // ZERO mutation — no transaction, no revision, no audit, no update.
    expect(harness.spies.transaction).not.toHaveBeenCalled();
    expect(harness.spies.revisionInsert).not.toHaveBeenCalled();
    expect(harness.spies.entryUpdate).not.toHaveBeenCalled();
    expect(harness.auditRows).toHaveLength(0);
    expect(harness.revisionRows).toHaveLength(0);
  });

  it('a tags-only change is still an effective edit — revision v2 keeps history complete', async () => {
    const harness = createCrudHarness([seedEntry()]);

    const updated = await harness.service.updateEntry(
      'entry-1',
      { currentVersion: 1, tags: ['อภิธานศัพท์', 'เล่มเพิ่มเติม'] } as never,
      'user-1',
    );

    // Hash unchanged (title+body untouched) but the edit is versioned.
    expect(updated.currentVersion).toBe(2);
    expect(updated.contentHash).toBe(
      computeKnowledgeContentHash(SEED_TITLE, SEED_BODY),
    );
    expect(harness.revisionRows).toHaveLength(1);
    expect(harness.revisionRows[0]).toMatchObject({
      version: 2,
      tags: ['อภิธานศัพท์', 'เล่มเพิ่มเติม'],
    });
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0]).toMatchObject({
      action: 'update',
      detail: expect.objectContaining({
        contentChanged: false,
        metadataChanged: true,
      }),
    });
  });

  it('stale currentVersion → 409 KNOWLEDGE_VERSION_CONFLICT, zero writes', async () => {
    const harness = createCrudHarness([seedEntry({ currentVersion: 3 })]);

    await expectHttpError(
      harness.service.updateEntry(
        'entry-1',
        { currentVersion: 2, bodyMd: 'changed' } as never,
        'user-1',
      ),
      409,
      'KNOWLEDGE_VERSION_CONFLICT',
    );

    expect(harness.spies.transaction).not.toHaveBeenCalled();
    expect(harness.revisionRows).toHaveLength(0);
    expect(harness.auditRows).toHaveLength(0);
    expect(harness.entryRows[0].currentVersion).toBe(3);
  });

  it('lost race (conditional UPDATE affects 0 rows) → 409, transaction aborts before audit', async () => {
    const harness = createCrudHarness([seedEntry()]);
    harness.spies.entryUpdate.mockResolvedValueOnce({ affected: 0 });

    await expectHttpError(
      harness.service.updateEntry(
        'entry-1',
        { currentVersion: 1, bodyMd: 'changed' } as never,
        'user-1',
      ),
      409,
      'KNOWLEDGE_VERSION_CONFLICT',
    );

    // The throw happens BEFORE the audit write — a real transaction
    // rolls the orphan revision insert back with it.
    expect(harness.auditRows).toHaveLength(0);
  });

  it('unknown domainKey on PATCH → 400 KNOWLEDGE_DOMAIN_UNKNOWN', async () => {
    const harness = createCrudHarness([seedEntry()]);

    await expectHttpError(
      harness.service.updateEntry(
        'entry-1',
        { currentVersion: 1, domainKey: 'nope' } as never,
        'user-1',
      ),
      400,
      'KNOWLEDGE_DOMAIN_UNKNOWN',
    );
    expect(harness.auditRows).toHaveLength(0);
  });

  it('missing entry → 404 KNOWLEDGE_ENTRY_NOT_FOUND', async () => {
    const harness = createCrudHarness();
    await expectHttpError(
      harness.service.updateEntry(
        'entry-missing',
        { currentVersion: 1, bodyMd: 'x' } as never,
        'user-1',
      ),
      404,
      'KNOWLEDGE_ENTRY_NOT_FOUND',
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. Lifecycle — publish / archive / soft delete
// ────────────────────────────────────────────────────────────────────

describe('lifecycle transitions (entry statuses — NOT workflow statuses)', () => {
  it('publish: draft → published, audits `publish` exactly once', async () => {
    const harness = createCrudHarness([seedEntry({ status: 'draft' })]);

    const published = await harness.service.publishEntry('entry-1', 'user-1');

    expect(published.status).toBe('published');
    expect(harness.entryRows[0].status).toBe('published');
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0]).toMatchObject({
      action: 'publish',
      targetId: 'entry-1',
      detail: { from: 'draft', to: 'published' },
    });
    // Publish never touches content/version (§17.4 — hash is content-only).
    expect(harness.entryRows[0].currentVersion).toBe(1);
    expect(harness.entryRows[0].contentHash).toBe(
      computeKnowledgeContentHash(SEED_TITLE, SEED_BODY),
    );
  });

  it('publish on a non-draft entry → 409 KNOWLEDGE_STATUS_INVALID', async () => {
    const harness = createCrudHarness([seedEntry({ status: 'published' })]);
    await expectHttpError(
      harness.service.publishEntry('entry-1', 'user-1'),
      409,
      'KNOWLEDGE_STATUS_INVALID',
    );
    expect(harness.auditRows).toHaveLength(0);
  });

  it('archive: published → archived, audits `archive` exactly once', async () => {
    const harness = createCrudHarness([seedEntry({ status: 'published' })]);

    const archived = await harness.service.archiveEntry('entry-1', 'user-1');

    expect(archived.status).toBe('archived');
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0]).toMatchObject({
      action: 'archive',
      detail: { from: 'published', to: 'archived' },
    });
  });

  it('archive on a draft → 409 KNOWLEDGE_STATUS_INVALID', async () => {
    const harness = createCrudHarness([seedEntry({ status: 'draft' })]);
    await expectHttpError(
      harness.service.archiveEntry('entry-1', 'user-1'),
      409,
      'KNOWLEDGE_STATUS_INVALID',
    );
  });

  it('lifecycle statuses never reuse canonical workflow status names (task §3)', async () => {
    const harness = createCrudHarness([seedEntry({ status: 'draft' })]);
    const published = await harness.service.publishEntry('entry-1', 'user-1');
    const workflowNames = [
      'Ready',
      'Pending',
      'Verified',
      'Pending_Approval',
      'Approved',
      'Pull_Back',
      'Returned_For_Revision',
      'Rejected',
    ];
    expect(workflowNames).not.toContain(published.status);
    expect(['draft', 'published', 'archived']).toContain(published.status);
  });

  it('soft delete: audit row precedes deletedAt inside one transaction', async () => {
    const harness = createCrudHarness([seedEntry({ status: 'published' })]);

    const result = await harness.service.deleteEntry('entry-1', 'user-1');

    expect(result).toEqual({ id: 'entry-1', deleted: true });
    expect(harness.entryRows[0].deletedAt).toBeInstanceOf(Date);
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0]).toMatchObject({
      action: 'delete',
      targetId: 'entry-1',
      detail: expect.objectContaining({ statusAtDelete: 'published' }),
    });
    // Tombstone-before-delete ordering (§18 spirit).
    const auditOrder = harness.spies.auditInsert.mock
      .invocationCallOrder[0] as number;
    const deleteOrder = harness.spies.entrySoftDelete.mock
      .invocationCallOrder[0] as number;
    expect(auditOrder).toBeLessThan(deleteOrder);
  });

  it('delete on a missing / already-deleted entry → 404', async () => {
    const harness = createCrudHarness([
      seedEntry({ deletedAt: new Date('2026-06-11T00:00:00Z') }),
    ]);
    await expectHttpError(
      harness.service.deleteEntry('entry-1', 'user-1'),
      404,
      'KNOWLEDGE_ENTRY_NOT_FOUND',
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 6. Read visibility + zero-write reads
// ────────────────────────────────────────────────────────────────────

const READ_MUTATION_METHODS = [
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'softDelete',
  'softRemove',
  'remove',
  'restore',
  'query',
] as const;

interface CaptureQueryBuilder {
  qb: Record<string, jest.Mock>;
  captured: {
    where: Array<[string, unknown?]>;
    andWhere: Array<[string, unknown?]>;
    skip?: number;
    take?: number;
  };
}

function createCaptureQueryBuilder(
  rows: unknown[],
  total: number,
): CaptureQueryBuilder {
  const captured: CaptureQueryBuilder['captured'] = {
    where: [],
    andWhere: [],
  };
  const qb: Record<string, jest.Mock> = {};
  qb.where = jest.fn((sql: string, params?: unknown) => {
    captured.where.push([sql, params]);
    return qb;
  });
  qb.andWhere = jest.fn((sql: string, params?: unknown) => {
    captured.andWhere.push([sql, params]);
    return qb;
  });
  qb.orderBy = jest.fn(() => qb);
  qb.skip = jest.fn((value: number) => {
    captured.skip = value;
    return qb;
  });
  qb.take = jest.fn((value: number) => {
    captured.take = value;
    return qb;
  });
  qb.getManyAndCount = jest.fn(async () => [rows, total]);
  return { qb, captured };
}

function createReadHarness(
  entries: EntryRow[],
  listRows: EntryRow[] = entries,
) {
  const { qb, captured } = createCaptureQueryBuilder(
    listRows,
    listRows.length,
  );
  const tripwires: jest.Mock[] = [];
  const withTripwires = (repo: Record<string, unknown>) => {
    for (const method of READ_MUTATION_METHODS) {
      const spy = jest.fn(() => {
        throw new Error(
          `ZERO-WRITE VIOLATION: repository.${method}() called from a read path (§18.13)`,
        );
      });
      repo[method] = spy;
      tripwires.push(spy);
    }
    return repo;
  };

  const entryRepo = withTripwires({
    findOne: jest.fn(
      async ({ where }: { where: { id: string } }) =>
        entries.find((row) => row.id === where.id && !row.deletedAt) ?? null,
    ),
    createQueryBuilder: jest.fn(() => qb),
    manager: {
      transaction: jest.fn(() => {
        throw new Error('ZERO-WRITE VIOLATION: transaction from a read path');
      }),
    },
  });
  const revisionRepo = withTripwires({
    find: jest.fn(async () => []),
  });
  const workHistoryRepo = withTripwires({ findOne: jest.fn() });
  const auditService = {
    record: jest.fn(() => {
      throw new Error('ZERO-WRITE VIOLATION: audit write from a read path');
    }),
  };

  const service = new AiKnowledgeHubService(
    entryRepo as never,
    revisionRepo as never,
    workHistoryRepo as never,
    auditService as never,
    // knowledgeSearchService — unused by the read paths under test.
    null as never,
    null,
  );

  return { service, captured, tripwires, revisionRepo };
}

describe('read surfaces — visibility + §18.13 zero-write discipline', () => {
  it('non-admin getEntry on a draft → 404 (existence-hiding); published → 200', async () => {
    const { service } = createReadHarness([
      seedEntry({ id: 'entry-draft', status: 'draft' }),
      seedEntry({ id: 'entry-pub', status: 'published' }),
      seedEntry({ id: 'entry-arch', status: 'archived' }),
    ]);

    await expectHttpError(
      service.getEntry('entry-draft', Role.STAFF),
      404,
      'KNOWLEDGE_ENTRY_NOT_FOUND',
    );
    await expectHttpError(
      service.getEntry('entry-arch', Role.C_LEVEL),
      404,
      'KNOWLEDGE_ENTRY_NOT_FOUND',
    );
    const published = await service.getEntry('entry-pub', Role.STAFF);
    expect(published.status).toBe('published');
  });

  it('admin getEntry reads any lifecycle status', async () => {
    const { service } = createReadHarness([
      seedEntry({ id: 'entry-draft', status: 'draft' }),
    ]);
    const draft = await service.getEntry('entry-draft', Role.ADMIN);
    expect(draft.status).toBe('draft');
  });

  it('non-admin list is FORCED to published — caller status filter is overridden', async () => {
    const { service, captured } = createReadHarness([], []);

    await service.listEntries({ status: 'draft' } as never, Role.STAFF);

    const statusFilter = captured.andWhere.find(([sql]) =>
      sql.includes('entry.status'),
    );
    expect(statusFilter?.[1]).toEqual({ status: 'published' });
  });

  it('admin list may filter any status (and defaults to ALL statuses)', async () => {
    const first = createReadHarness([], []);
    await first.service.listEntries({ status: 'draft' } as never, Role.ADMIN);
    expect(
      first.captured.andWhere.find(([sql]) => sql.includes('entry.status'))?.[1],
    ).toEqual({ status: 'draft' });

    const second = createReadHarness([], []);
    await second.service.listEntries({} as never, Role.SUPER_ADMIN);
    expect(
      second.captured.andWhere.some(([sql]) => sql.includes('entry.status')),
    ).toBe(false);
  });

  it('list clamps limit to 100 and paginates via skip/take', async () => {
    const { service, captured } = createReadHarness([], []);

    const result = await service.listEntries(
      { page: 3, limit: 500 } as never,
      Role.ADMIN,
    );

    expect(result.limit).toBe(100);
    expect(captured.take).toBe(100);
    expect(captured.skip).toBe(200);
    expect(result.page).toBe(3);
  });

  it('search escapes LIKE metacharacters (q is always a literal needle)', async () => {
    const { service, captured } = createReadHarness([], []);

    await service.listEntries({ q: '100%_x' } as never, Role.ADMIN);

    const searchFilter = captured.andWhere.find(([sql]) =>
      sql.includes('ILIKE'),
    );
    expect(searchFilter?.[1]).toEqual({ q: '%100\\%\\_x%' });
  });

  it('revisions list returns newest-first and 404s a missing entry', async () => {
    const harness = createCrudHarness([seedEntry()]);
    harness.revisionRows.push(
      { id: 'r1', entryId: 'entry-1', version: 1 },
      { id: 'r2', entryId: 'entry-1', version: 2 },
    );

    const revisions = await harness.service.listEntryRevisions('entry-1');
    expect(revisions.map((revision) => revision.version)).toEqual([2, 1]);

    await expectHttpError(
      harness.service.listEntryRevisions('missing'),
      404,
      'KNOWLEDGE_ENTRY_NOT_FOUND',
    );
  });

  it('reads never touch a mutating repository method (§18.13 tripwires)', async () => {
    const harness = createReadHarness([
      seedEntry({ id: 'entry-pub', status: 'published' }),
    ]);

    await harness.service.listEntries({} as never, Role.STAFF);
    await harness.service.getEntry('entry-pub', Role.STAFF);

    for (const spy of harness.tripwires) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// 7. §17.3 hygiene — no TrackingStatus / project-table imports
// ────────────────────────────────────────────────────────────────────

describe('module hygiene — §17.3 (grep-style spec, task §7)', () => {
  const moduleRoot = path.join(__dirname, '..');

  const collectSourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name === '__tests__') continue;
        out.push(...collectSourceFiles(fullPath));
      } else if (item.name.endsWith('.ts')) {
        out.push(fullPath);
      }
    }
    return out;
  };

  it('no module file imports tracking-status or any project-owning entity', () => {
    const offenders: string[] = [];
    for (const filePath of collectSourceFiles(moduleRoot)) {
      const importLines = fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((line) => /^\s*(import|export)\s.*from\s+['"]/.test(line));
      for (const line of importLines) {
        if (
          /tracking[-_]?status/i.test(line) ||
          /project-group|project_groups/i.test(line) ||
          /development-plan/i.test(line)
        ) {
          offenders.push(`${path.basename(filePath)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('audit rows carry the full §17.3 actor identity contract', async () => {
    const harness = createCrudHarness([], { actorRole: 'super-admin' });
    await harness.service.createEntry(
      { domainKey: 'faq', title: 'q', bodyMd: 'a' } as never,
      'user-9',
    );
    expect(harness.auditRows[0]).toMatchObject({
      actorWorkHistoryId: 'wh-admin-1',
      actorRole: 'super-admin',
      action: 'create',
      targetKind: 'entry',
    });
    // target referenced by plain uuid — never an entity relation object.
    expect(typeof harness.auditRows[0].targetId).toBe('string');
  });
});
