/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * Source-lifecycle + four-eyes acceptance specs (task §3.1 / §6):
 *
 * 1. Create lands at `pending_approval`, mode server-forced `webhook`
 *    (Q3), returns the PLAINTEXT key exactly once; the DB row stores
 *    only the argon2 digest + 12-char prefix (never the plaintext).
 * 2. Four-eyes — creator self-approval → 403 SOURCE_FOUR_EYES_REQUIRED;
 *    a SECOND admin approves → `active` (audit `source_approve`).
 * 3. PDPA — empty purpose/lawful-basis blocks approval (422).
 * 4. Suspend / revoke transitions + revoked is terminal (rotate-key and
 *    PATCH refuse).
 * 5. Rotate-key — old key stops verifying, new plaintext returned once.
 * 6. Every mutation writes exactly one `ai_knowledge_audit_logs` row;
 *    audit detail never contains the plaintext key.
 * 7. Controller role matrix — every /sources* route is SUPER_ADMIN_ONLY
 *    behind the JWT chain (2026-06-16 super-admin-only narrowing).
 */
import { Reflector } from '@nestjs/core';
import * as argon2 from 'argon2';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { SUPER_ADMIN_ONLY } from '../../auth/role-groups';
import { ROLES_KEY } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../../auth/work-status-approved.guard';
import { KnowledgeIngestController } from '../controllers/knowledge-ingest.controller';
import { CreateKnowledgeSourceDto } from '../dto/knowledge-source.dto';
import { KnowledgeSourceApiKeyGuard } from '../guards/knowledge-source-api-key.guard';
import { KnowledgeAuditService } from '../services/knowledge-audit.service';
import { KnowledgeSourceService } from '../services/knowledge-source.service';
import { expectHttpError, makeHarnessRepos } from './connector-test.util';

jest.setTimeout(60_000);

const VALID_DOMAIN_KEY = 'glossary';

function createDto(
  overrides: Partial<CreateKnowledgeSourceDto> = {},
): CreateKnowledgeSourceDto {
  return {
    name: 'ระบบสารสนเทศจังหวัด',
    description: 'แหล่งความรู้ภายนอกจากระบบจังหวัด',
    sourceKey: 'province-info',
    owningAgencyNote: 'ศูนย์เทคโนโลยีสารสนเทศจังหวัดนครราชสีมา',
    payloadSchema: {
      type: 'object',
      required: ['title', 'body_md'],
      properties: {
        title: { type: 'string', maxLength: 300 },
        body_md: { type: 'string' },
      },
    },
    targetDomainKey: VALID_DOMAIN_KEY,
    purposeDeclaration: 'เผยแพร่องค์ความรู้การวางแผนพัฒนาท้องถิ่น',
    lawfulBasis: 'legitimate-interest',
    ...overrides,
  };
}

interface LifecycleHarness {
  service: KnowledgeSourceService;
  sourceRows: Record<string, unknown>[];
  auditRows: Record<string, unknown>[];
}

function createHarness(): LifecycleHarness {
  const repos = makeHarnessRepos();
  const service = new KnowledgeSourceService(
    repos.sourceRepo as never,
    repos.ingestionRepo as never,
    repos.workHistoryRepo as never,
    new KnowledgeAuditService(repos.throwingAuditRepo as never),
  );
  return {
    service,
    sourceRows: repos.sourceRepo.rows,
    auditRows: repos.auditRows,
  };
}

describe('BE-03 source lifecycle (KnowledgeSourceService)', () => {
  it('creates a pending_approval webhook source and returns the plaintext key exactly once', async () => {
    const h = createHarness();
    const result = await h.service.createSource(createDto(), 'user-admin-1');

    expect(result.apiKey).toMatch(/^pbk_live_/);
    expect(result.source.status).toBe('pending_approval');
    expect(result.source.mode).toBe('webhook'); // Q3 — server-forced
    expect(result.source.apiKeyPrefix).toBe(result.apiKey.slice(0, 12));

    // Persisted row: digest only — plaintext never stored anywhere.
    const row = h.sourceRows[0] as { apiKeyHash: string };
    expect(row.apiKeyHash).not.toContain(result.apiKey);
    expect(JSON.stringify(h.sourceRows)).not.toContain(result.apiKey);
    expect(JSON.stringify(h.auditRows)).not.toContain(result.apiKey);
    await expect(argon2.verify(row.apiKeyHash, result.apiKey)).resolves.toBe(
      true,
    );

    // The DTO projection never exposes hash columns.
    expect(
      (result.source as unknown as Record<string, unknown>).apiKeyHash,
    ).toBeUndefined();

    // Exactly one audit row (source_create), no plaintext in detail.
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]).toMatchObject({
      action: 'source_create',
      targetKind: 'source',
      actorWorkHistoryId: 'wh-user-admin-1',
    });
  });

  it('rejects a duplicate sourceKey with 409 SOURCE_KEY_TAKEN', async () => {
    const h = createHarness();
    await h.service.createSource(createDto(), 'user-admin-1');
    await expectHttpError(
      h.service.createSource(createDto(), 'user-admin-1'),
      409,
      'SOURCE_KEY_TAKEN',
    );
  });

  it('blocks creator self-approval with 403 SOURCE_FOUR_EYES_REQUIRED (no role exemption)', async () => {
    const h = createHarness();
    const created = await h.service.createSource(createDto(), 'user-admin-1');

    await expectHttpError(
      h.service.approveSource(created.source.id, 'user-admin-1'),
      403,
      'SOURCE_FOUR_EYES_REQUIRED',
    );
    // Still pending — nothing mutated.
    expect((h.sourceRows[0] as { status: string }).status).toBe(
      'pending_approval',
    );
  });

  it('activates via a SECOND admin (4-eyes) and audits source_approve', async () => {
    const h = createHarness();
    const created = await h.service.createSource(createDto(), 'user-admin-1');

    const approved = await h.service.approveSource(
      created.source.id,
      'user-admin-2',
    );
    expect(approved.status).toBe('active');
    expect(approved.approvedByWorkHistoryId).toBe('wh-user-admin-2');

    const row = h.sourceRows[0] as Record<string, unknown>;
    expect(row.status).toBe('active');
    expect(
      h.auditRows.filter((a) => a.action === 'source_approve'),
    ).toHaveLength(1);
  });

  it('blocks approval while PDPA purpose/lawful-basis are empty (422)', async () => {
    const h = createHarness();
    const created = await h.service.createSource(createDto(), 'user-admin-1');
    // Simulate a legacy/blanked row — the DTO forbids empty strings at
    // create time, so blank the persisted row directly.
    (h.sourceRows[0] as Record<string, unknown>).purposeDeclaration = '   ';

    await expectHttpError(
      h.service.approveSource(created.source.id, 'user-admin-2'),
      422,
      'SOURCE_PDPA_FIELDS_REQUIRED',
    );
  });

  it('suspend requires active; revoke is terminal (rotate-key + PATCH refuse)', async () => {
    const h = createHarness();
    const created = await h.service.createSource(createDto(), 'user-admin-1');

    // suspend from pending_approval → 409
    await expectHttpError(
      h.service.suspendSource(created.source.id, 'user-admin-2'),
      409,
      'SOURCE_STATUS_INVALID',
    );

    await h.service.approveSource(created.source.id, 'user-admin-2');
    const suspended = await h.service.suspendSource(
      created.source.id,
      'user-admin-2',
    );
    expect(suspended.status).toBe('suspended');

    const revoked = await h.service.revokeSource(
      created.source.id,
      'user-admin-2',
    );
    expect(revoked.status).toBe('revoked');

    await expectHttpError(
      h.service.rotateKey(created.source.id, 'user-admin-2'),
      409,
      'SOURCE_STATUS_INVALID',
    );
    await expectHttpError(
      h.service.updateSource(
        created.source.id,
        { name: 'ใหม่' },
        'user-admin-2',
      ),
      409,
      'SOURCE_STATUS_INVALID',
    );
    await expectHttpError(
      h.service.revokeSource(created.source.id, 'user-admin-2'),
      409,
      'SOURCE_STATUS_INVALID',
    );

    const actions = h.auditRows.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'source_create',
        'source_approve',
        'source_suspend',
        'source_revoke',
      ]),
    );
  });

  it('rotate-key invalidates the old key and returns a new plaintext once', async () => {
    const h = createHarness();
    const created = await h.service.createSource(createDto(), 'user-admin-1');
    const oldKey = created.apiKey;

    const rotated = await h.service.rotateKey(created.source.id, 'user-admin-2');
    expect(rotated.apiKey).toMatch(/^pbk_live_/);
    expect(rotated.apiKey).not.toBe(oldKey);

    const row = h.sourceRows[0] as { apiKeyHash: string; apiKeyPrefix: string };
    await expect(argon2.verify(row.apiKeyHash, oldKey)).resolves.toBe(false);
    await expect(argon2.verify(row.apiKeyHash, rotated.apiKey)).resolves.toBe(
      true,
    );
    expect(row.apiKeyPrefix).toBe(rotated.apiKey.slice(0, 12));
    expect(JSON.stringify(h.sourceRows)).not.toContain(rotated.apiKey);
    expect(JSON.stringify(h.auditRows)).not.toContain(rotated.apiKey);
    expect(
      h.auditRows.filter((a) => a.action === 'source_rotate_key'),
    ).toHaveLength(1);
  });

  it('PATCH edits schema/rate-limit/domain and audits as update on targetKind source', async () => {
    const h = createHarness();
    const created = await h.service.createSource(createDto(), 'user-admin-1');

    const updated = await h.service.updateSource(
      created.source.id,
      { rateLimitPerMin: 10, payloadSchema: { type: 'object' } },
      'user-admin-2',
    );
    expect(updated.rateLimitPerMin).toBe(10);
    expect(updated.status).toBe('pending_approval'); // status untouched

    const audit = h.auditRows.find(
      (a) => a.action === 'update' && a.targetKind === 'source',
    );
    expect(audit).toBeDefined();
    expect((audit?.detail as { changedFields: string[] }).changedFields).toEqual(
      expect.arrayContaining(['rateLimitPerMin', 'payloadSchema']),
    );
  });
});

describe('BE-03 controller role matrix (real metadata)', () => {
  const reflector = new Reflector();

  const adminHandlers: Array<keyof KnowledgeIngestController> = [
    'listSources',
    'getSource',
    'createSource',
    'approveSource',
    'suspendSource',
    'revokeSource',
    'rotateKey',
    'updateSource',
    'listIngestions',
    'promoteIngestion',
    'rejectIngestion',
  ];

  it.each(adminHandlers)(
    '%s is SUPER_ADMIN_ONLY behind the JWT chain (2026-06-16 super-admin-only narrowing)',
    (handler) => {
      const method = KnowledgeIngestController.prototype[handler] as object;
      const roles = reflector.get<string[]>(ROLES_KEY, method as never);
      expect(roles).toEqual([...SUPER_ADMIN_ONLY]);

      const guards: unknown[] =
        Reflect.getMetadata('__guards__', method) ?? [];
      expect(guards).toEqual(
        expect.arrayContaining([
          JwtAuthGuard,
          RolesGuard,
          WorkStatusApprovedGuard,
        ]),
      );
    },
  );

  it('ingest route uses the API-key guard ONLY (no JWT, no roles)', () => {
    const method = KnowledgeIngestController.prototype.ingest as object;
    const roles = reflector.get<string[]>(ROLES_KEY, method as never);
    expect(roles).toBeUndefined();

    const guards: unknown[] = Reflect.getMetadata('__guards__', method) ?? [];
    expect(guards).toEqual([KnowledgeSourceApiKeyGuard]);
    expect(guards).not.toEqual(expect.arrayContaining([JwtAuthGuard]));
  });
});
