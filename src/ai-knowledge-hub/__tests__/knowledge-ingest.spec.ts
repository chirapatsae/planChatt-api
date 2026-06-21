/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * Ingest-guard / idempotency / pii-block acceptance specs (task §3.2 /
 * §3.3 / §3.4 / §6):
 *
 * 1. Guard — forged key → 401; valid key on suspended/revoked/pending
 *    source → 403; valid key + wrong sourceKey slug → 401; staging is
 *    NEVER touched on any failure path.
 * 2. Rate limit — per-source `rate_limit_per_min`; exceed → 429
 *    `{ code: 'INGEST_RATE_LIMITED', retryAfterSeconds }`.
 * 3. Idempotency — required `X-Idempotency-Key`; duplicate
 *    `(source_id, key)` returns the ORIGINAL row id, no second row.
 * 4. Schema — invalid payload lands `rejected` WITH stored errors;
 *    valid lands `quarantined`. Size cap → 413.
 * 5. PII (Q4) — flags recorded at receipt; promote blocked 422
 *    INGEST_PII_BLOCKED until the effective mapped fields are clean;
 *    successful promote spawns a DRAFT entry (`origin='external'`,
 *    never auto-published) via the BE-02 service, atomically with the
 *    verdict + audit rows.
 * 6. Retention cron — aged rejected/unreviewed rows purged in place
 *    (`status='purged'`, payload emptied); promoted rows untouched;
 *    failures swallowed (never rethrow).
 * 7. Hygiene — zero TrackingStatus / project-table imports in any
 *    BE-03 file (grep-style spec, BE-02 precedent).
 */
import { ExecutionContext } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as fs from 'fs';
import * as path from 'path';

import { AiKnowledgeHubService } from '../ai-knowledge-hub.service';
import { KnowledgeSourceApiKeyGuard } from '../guards/knowledge-source-api-key.guard';
import { KnowledgeIngestionRetentionCron } from '../knowledge-ingestion-retention.cron';
import { KnowledgeAuditService } from '../services/knowledge-audit.service';
import {
  KnowledgeIngestionService,
  validateAgainstDeclaredSchema,
} from '../services/knowledge-ingestion.service';
import { KnowledgeSourceService } from '../services/knowledge-source.service';
import { scanForPii } from '../services/pii-scan.util';
import {
  expectHttpError,
  HarnessRepos,
  makeHarnessRepos,
} from './connector-test.util';

// `KnowledgeSourceService` imports the env-keyed AES util (HMAC secret at
// rest). Jest forces NODE_ENV=test, so the real util can't find `.env.test`
// and throws at import. These ingest specs don't exercise encryption, so
// stub it (codebase convention — see users.service.spec.ts).
jest.mock('../../util/encryption.util', () => ({
  encryption: jest.fn((value: string) => Promise.resolve(value)),
  decryption: jest.fn((value: string) => Promise.resolve(value)),
}));

jest.setTimeout(60_000);

const RAW_KEY = 'pbk_live_TEST-test-test-test-test-test-test-tes';

interface IngestHarness {
  repos: HarnessRepos;
  sourceService: KnowledgeSourceService;
  ingestionService: KnowledgeIngestionService;
  guard: KnowledgeSourceApiKeyGuard;
  source: Record<string, any>;
}

let cachedKeyHash: string;

beforeAll(async () => {
  cachedKeyHash = await argon2.hash(RAW_KEY, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
});

function seedSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'src-active-1',
    name: 'ระบบสารสนเทศจังหวัด',
    description: 'desc',
    sourceKey: 'province-info',
    owningAgencyNote: 'note',
    mode: 'webhook',
    status: 'active',
    apiKeyHash: cachedKeyHash,
    apiKeyPrefix: RAW_KEY.slice(0, 12),
    hmacSecretHash: null,
    payloadSchema: {
      type: 'object',
      required: ['title', 'body_md'],
      properties: {
        title: { type: 'string', maxLength: 300 },
        body_md: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    targetDomainKey: 'glossary',
    classificationCeiling: 'internal',
    rateLimitPerMin: 60,
    maxPayloadBytes: 262144,
    purposeDeclaration: 'purpose',
    lawfulBasis: 'legitimate-interest',
    createdByWorkHistoryId: 'wh-user-admin-1',
    approvedByWorkHistoryId: 'wh-user-admin-2',
    approvedAt: new Date(),
    lastSeenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function createHarness(
  sourceOverrides: Record<string, unknown> = {},
): IngestHarness {
  const repos = makeHarnessRepos();
  const source = seedSource(sourceOverrides);
  repos.sourceRepo.rows.push(source);

  const audit = new KnowledgeAuditService(repos.throwingAuditRepo as never);
  const sourceService = new KnowledgeSourceService(
    repos.sourceRepo as never,
    repos.ingestionRepo as never,
    repos.workHistoryRepo as never,
    audit,
  );
  const hubService = new AiKnowledgeHubService(
    repos.entryRepo as never,
    repos.revisionRepo as never,
    repos.workHistoryRepo as never,
    audit,
    // knowledgeSearchService — unused by the promotion path under test.
    null as never,
    repos.sourceRepo as never,
  );
  const ingestionService = new KnowledgeIngestionService(
    repos.ingestionRepo as never,
    repos.sourceRepo as never,
    repos.workHistoryRepo as never,
    audit,
    hubService,
  );
  const guard = new KnowledgeSourceApiKeyGuard(sourceService);

  return { repos, sourceService, ingestionService, guard, source };
}

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const VALID_PAYLOAD = {
  title: 'เล่มเพิ่มเติมคืออะไร',
  body_md: 'เล่มเพิ่มเติม คือเล่มที่เพิ่มโครงการใหม่เข้าแผนพัฒนา',
  tags: ['อภิธานศัพท์'],
};

describe('BE-03 ingest guard (KnowledgeSourceApiKeyGuard)', () => {
  it('rejects a forged key with 401 and never touches staging', async () => {
    const h = createHarness();
    const req: Record<string, unknown> = {
      params: { sourceKey: 'province-info' },
      headers: { 'x-pbk-api-key': `${RAW_KEY.slice(0, 12)}forged-body` },
    };
    await expectHttpError(
      h.guard.canActivate(makeContext(req)),
      401,
      'INGEST_KEY_INVALID',
    );
    expect(h.repos.ingestionRepo.rows).toHaveLength(0);
    expect(req.knowledgeSource).toBeUndefined();
  });

  it('rejects a missing key header with 401', async () => {
    const h = createHarness();
    await expectHttpError(
      h.guard.canActivate(
        makeContext({ params: { sourceKey: 'province-info' }, headers: {} }),
      ),
      401,
      'INGEST_KEY_INVALID',
    );
  });

  it.each(['suspended', 'revoked', 'pending_approval'])(
    'rejects a VALID key on a %s source with 403 (never touches staging)',
    async (status) => {
      const h = createHarness({ status });
      await expectHttpError(
        h.guard.canActivate(
          makeContext({
            params: { sourceKey: 'province-info' },
            headers: { 'x-pbk-api-key': RAW_KEY },
          }),
        ),
        403,
        'INGEST_SOURCE_NOT_ACTIVE',
      );
      expect(h.repos.ingestionRepo.rows).toHaveLength(0);
    },
  );

  it('answers 401 when a valid key targets another sourceKey slug (no enumeration)', async () => {
    const h = createHarness();
    await expectHttpError(
      h.guard.canActivate(
        makeContext({
          params: { sourceKey: 'someone-elses-slug' },
          headers: { 'x-pbk-api-key': RAW_KEY },
        }),
      ),
      401,
      'INGEST_KEY_INVALID',
    );
  });

  it('admits a valid key on an active source and attaches the source row', async () => {
    const h = createHarness();
    const req: Record<string, unknown> = {
      params: { sourceKey: 'province-info' },
      headers: { 'x-pbk-api-key': RAW_KEY },
    };
    await expect(h.guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect((req.knowledgeSource as { id: string }).id).toBe('src-active-1');
  });
});

describe('BE-03 ingest endpoint (KnowledgeIngestionService.ingest)', () => {
  it('stores a schema-valid payload as quarantined and touches last_seen_at', async () => {
    const h = createHarness();
    const result = await h.ingestionService.ingest(
      h.source as never,
      VALID_PAYLOAD,
      'idem-1',
      '203.0.113.7',
    );

    expect(result.status).toBe('quarantined');
    expect(result.duplicate).toBe(false);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);

    expect(h.repos.ingestionRepo.rows).toHaveLength(1);
    const row = h.repos.ingestionRepo.rows[0];
    expect(row.status).toBe('quarantined');
    expect(row.validationErrors).toBeNull();
    expect(row.remoteIp).toBe('203.0.113.7');
    expect(h.source.lastSeenAt).toBeInstanceOf(Date);
  });

  it('requires X-Idempotency-Key (400) and dedupes duplicates to the ORIGINAL row', async () => {
    const h = createHarness();
    await expectHttpError(
      h.ingestionService.ingest(h.source as never, VALID_PAYLOAD, undefined, null),
      400,
      'INGEST_IDEMPOTENCY_KEY_REQUIRED',
    );
    expect(h.repos.ingestionRepo.rows).toHaveLength(0);

    const first = await h.ingestionService.ingest(
      h.source as never,
      VALID_PAYLOAD,
      'idem-dup',
      null,
    );
    const second = await h.ingestionService.ingest(
      h.source as never,
      { totally: 'different payload' },
      'idem-dup',
      null,
    );

    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(h.repos.ingestionRepo.rows).toHaveLength(1); // no re-insert
  });

  it('stores a schema-invalid payload as rejected WITH validation errors (still auditable)', async () => {
    const h = createHarness();
    const result = await h.ingestionService.ingest(
      h.source as never,
      { title: 'มีแต่หัวข้อ' }, // missing required body_md
      'idem-invalid',
      null,
    );

    expect(result.status).toBe('rejected');
    const row = h.repos.ingestionRepo.rows[0];
    expect(row.status).toBe('rejected');
    expect(
      (row.validationErrors as { errors: string[] }).errors.join(' '),
    ).toContain("missing required property 'body_md'");
  });

  it('rejects oversized payloads with 413 before any write', async () => {
    const h = createHarness({ maxPayloadBytes: 64 });
    await expectHttpError(
      h.ingestionService.ingest(
        h.source as never,
        VALID_PAYLOAD,
        'idem-big',
        null,
      ),
      413,
      'INGEST_PAYLOAD_TOO_LARGE',
    );
    expect(h.repos.ingestionRepo.rows).toHaveLength(0);
  });

  it('enforces the per-source rate limit with the §17.8-shaped 429 envelope', async () => {
    const h = createHarness({ rateLimitPerMin: 2 });
    await h.ingestionService.ingest(h.source as never, VALID_PAYLOAD, 'r1', null);
    await h.ingestionService.ingest(h.source as never, VALID_PAYLOAD, 'r2', null);

    let caught: unknown;
    try {
      await h.ingestionService.ingest(h.source as never, VALID_PAYLOAD, 'r3', null);
    } catch (err) {
      caught = err;
    }
    const body = (caught as { getResponse: () => Record<string, unknown> })
      .getResponse();
    expect((caught as { getStatus: () => number }).getStatus()).toBe(429);
    expect(body.code).toBe('INGEST_RATE_LIMITED');
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(body.retryAfterSeconds as number).toBeGreaterThanOrEqual(1);
    expect(h.repos.ingestionRepo.rows).toHaveLength(2);
  });

  it('records masked PII flags at receipt (Thai ID / phone / email)', async () => {
    const h = createHarness();
    await h.ingestionService.ingest(
      h.source as never,
      {
        title: 'ติดต่อ 0812345678',
        body_md: 'เลขบัตร 1234567890123 อีเมล someone@example.com',
      },
      'idem-pii',
      null,
    );
    const row = h.repos.ingestionRepo.rows[0];
    const flags = (row.piiFlags as { flags: Array<Record<string, string>> })
      .flags;
    const types = flags.map((f) => f.type);
    expect(types).toEqual(
      expect.arrayContaining(['thai_national_id', 'phone', 'email']),
    );
    // Masked samples — raw PII never re-stored.
    const serialized = JSON.stringify(flags);
    expect(serialized).not.toContain('0812345678');
    expect(serialized).not.toContain('1234567890123');
    expect(serialized).not.toContain('someone@example.com');
  });
});

describe('BE-03 quarantine review (promote / reject)', () => {
  it('blocks promote with 422 INGEST_PII_BLOCKED while the effective mapped fields carry PII', async () => {
    const h = createHarness();
    await h.ingestionService.ingest(
      h.source as never,
      { title: 'โทร 0812345678', body_md: 'เนื้อหาปกติ' },
      'idem-p1',
      null,
    );
    const row = h.repos.ingestionRepo.rows[0];

    await expectHttpError(
      h.ingestionService.promote(row.id, {}, 'user-admin-1'),
      422,
      'INGEST_PII_BLOCKED',
    );
    expect(row.status).toBe('quarantined'); // verdict untouched
    expect(h.repos.entryRepo.rows).toHaveLength(0); // no entry spawned
  });

  it('promotes once PII is masked via overrides → DRAFT entry origin=external, atomic audit', async () => {
    const h = createHarness();
    await h.ingestionService.ingest(
      h.source as never,
      { title: 'โทร 0812345678', body_md: 'เนื้อหาปกติ' },
      'idem-p2',
      null,
    );
    const row = h.repos.ingestionRepo.rows[0];

    const result = await h.ingestionService.promote(
      row.id,
      { title: 'โทร 08x-xxx-xxxx (ปิดบังแล้ว)' },
      'user-admin-1',
    );

    // DRAFT entry — never auto-published (acceptance §6).
    expect(result.entry.status).toBe('draft');
    expect(result.entry.origin).toBe('external');
    expect(result.entry.sourceId).toBe('src-active-1');
    expect(result.entry.domainKey).toBe('glossary'); // source target default
    expect(result.entry.classification).toBe('internal'); // ceiling (Q4)

    // Verdict recorded on the staging row.
    expect(row.status).toBe('promoted');
    expect(row.promotedEntryId).toBe(result.entry.id);
    expect(row.reviewedByWorkHistoryId).toBe('wh-user-admin-1');

    // Entry + revision v1 persisted; audit has BOTH create + promote.
    expect(h.repos.entryRepo.rows).toHaveLength(1);
    expect(h.repos.revisionRepo.rows).toHaveLength(1);
    const actions = h.repos.auditRows.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'promote']));
  });

  it('rejects only quarantined items; promote on promoted → 409', async () => {
    const h = createHarness();
    await h.ingestionService.ingest(
      h.source as never,
      VALID_PAYLOAD,
      'idem-p3',
      null,
    );
    const row = h.repos.ingestionRepo.rows[0];

    const rejected = await h.ingestionService.reject(
      row.id,
      { reason: 'เนื้อหาไม่เกี่ยวข้อง' },
      'user-admin-1',
    );
    expect(rejected.status).toBe('rejected');
    expect(row.status).toBe('rejected');
    expect(
      h.repos.auditRows.filter((a) => a.action === 'reject'),
    ).toHaveLength(1);

    await expectHttpError(
      h.ingestionService.promote(row.id, {}, 'user-admin-1'),
      409,
      'INGEST_STATUS_INVALID',
    );
  });
});

describe('BE-03 pii-scan util', () => {
  it('flags dashed Thai national IDs and nested payload paths', () => {
    const flags = scanForPii({
      citizen: { idCard: 'เลข 1-2345-67890-12-3' },
      list: ['ok', 'mail me at a.b@c.go.th'],
    });
    expect(flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thai_national_id',
          path: '$.citizen.idCard',
        }),
        expect.objectContaining({ type: 'email', path: '$.list[1]' }),
      ]),
    );
  });

  it('does not flag ordinary Thai text, years, or budget figures', () => {
    expect(
      scanForPii({
        title: 'โครงการก่อสร้างถนน ปี 2569 งบประมาณ 1,500,000 บาท',
        body_md: 'พิกัด 14.97 102.10 พื้นที่ 12345 ไร่',
      }),
    ).toEqual([]);
  });
});

describe('BE-03 declared-schema validator', () => {
  const schema = {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 3, maxLength: 10 },
      count: { type: 'integer', minimum: 0, maximum: 5 },
      kind: { enum: ['a', 'b'] },
      items: { type: 'array', items: { type: 'string' } },
    },
  };

  it('accepts a conforming payload', () => {
    expect(
      validateAgainstDeclaredSchema(
        { title: 'hello', count: 3, kind: 'a', items: ['x'] },
        schema,
      ),
    ).toEqual([]);
  });

  it('reports missing required / type / bounds / enum / extra-prop errors', () => {
    const errors = validateAgainstDeclaredSchema(
      { count: 99, kind: 'z', items: [1], extra: true },
      schema,
    );
    expect(errors.join('\n')).toContain("missing required property 'title'");
    expect(errors.join('\n')).toContain('above maximum 5');
    expect(errors.join('\n')).toContain('not in enum');
    expect(errors.join('\n')).toContain('expected type string');
    expect(errors.join('\n')).toContain("unexpected property 'extra'");
  });

  it('treats an empty/non-object schema as accept-all', () => {
    expect(validateAgainstDeclaredSchema({ anything: 1 }, {})).toEqual([]);
    expect(validateAgainstDeclaredSchema({ anything: 1 }, null)).toEqual([]);
  });
});

describe('BE-03 retention cron (knowledge-ingestion-retention)', () => {
  function makeRows() {
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    return [
      {
        id: 'ing-old-rejected',
        status: 'rejected',
        receivedAt: old,
        payload: { secret: 'x' },
        validationErrors: { errors: ['e'] },
        piiFlags: null,
        deletedAt: null,
      },
      {
        id: 'ing-old-quarantined',
        status: 'quarantined',
        receivedAt: old,
        payload: { secret: 'y' },
        validationErrors: null,
        piiFlags: { flags: [] },
        deletedAt: null,
      },
      {
        id: 'ing-old-promoted',
        status: 'promoted',
        receivedAt: old,
        payload: { keep: 'me' },
        validationErrors: null,
        piiFlags: null,
        deletedAt: null,
      },
      {
        id: 'ing-fresh',
        status: 'quarantined',
        receivedAt: new Date(),
        payload: { keep: 'me' },
        validationErrors: null,
        piiFlags: null,
        deletedAt: null,
      },
    ];
  }

  it('purges aged rejected/unreviewed rows in place; promoted + fresh untouched', async () => {
    const rows = makeRows();
    const repo = {
      find: async () =>
        rows
          .filter(
            (r) =>
              (r.status === 'rejected' || r.status === 'quarantined') &&
              r.receivedAt.getTime() < Date.now() - 90 * 24 * 60 * 60 * 1000,
          )
          .map((r) => ({ id: r.id })),
      update: async (
        criteria: { id: unknown },
        patch: Record<string, unknown>,
      ) => {
        // TypeORM In() FindOperator — read its value array.
        const op = criteria.id as { value?: string[]; _value?: string[] };
        const ids: string[] = op.value ?? op._value ?? [];
        let affected = 0;
        for (const row of rows) {
          if (ids.includes(row.id)) {
            Object.assign(row, patch);
            affected += 1;
          }
        }
        return { affected };
      },
    };

    const cron = new KnowledgeIngestionRetentionCron(repo as never);
    await cron.runDailyRetention();

    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('ing-old-rejected')?.status).toBe('purged');
    expect(byId.get('ing-old-rejected')?.payload).toEqual({});
    expect(byId.get('ing-old-rejected')?.validationErrors).toBeNull();
    expect(byId.get('ing-old-quarantined')?.status).toBe('purged');
    expect(byId.get('ing-old-quarantined')?.piiFlags).toBeNull();
    expect(byId.get('ing-old-promoted')?.status).toBe('promoted');
    expect(byId.get('ing-old-promoted')?.payload).toEqual({ keep: 'me' });
    expect(byId.get('ing-fresh')?.status).toBe('quarantined');
  });

  it('never rethrows on failure (retention.cron.ts discipline)', async () => {
    const repo = {
      find: async () => {
        throw new Error('db hiccup');
      },
      update: async () => ({ affected: 0 }),
    };
    const cron = new KnowledgeIngestionRetentionCron(repo as never);
    await expect(cron.runDailyRetention()).resolves.toBeUndefined();
  });
});

describe('BE-03 hygiene — zero TrackingStatus / project-table imports', () => {
  const moduleDir = path.resolve(__dirname, '..');
  const be03Files = [
    'services/knowledge-source.service.ts',
    'services/knowledge-ingestion.service.ts',
    'services/pii-scan.util.ts',
    'guards/knowledge-source-api-key.guard.ts',
    'controllers/knowledge-ingest.controller.ts',
    'knowledge-ingestion-retention.cron.ts',
    'dto/knowledge-source.dto.ts',
    'dto/knowledge-ingestion.dto.ts',
  ];

  it.each(be03Files)('%s never touches workflow audit or project tables', (file) => {
    const content = fs.readFileSync(path.join(moduleDir, file), 'utf8');
    // Import-level bans — prose comments MAY cite the rules by name,
    // but no BE-03 file may import workflow-audit or project entities.
    expect(content).not.toMatch(/from ['"].*tracking-status/);
    expect(content).not.toMatch(/import .*TrackingStatus/);
    expect(content).not.toMatch(/from ['"].*project-groups\/entities/);
    expect(content).not.toMatch(/from ['"].*revised-project-group/);
    expect(content).not.toMatch(/from ['"].*supplement-project-group/);
    expect(content).not.toMatch(/from ['"].*equipment-project-group/);
  });
});
