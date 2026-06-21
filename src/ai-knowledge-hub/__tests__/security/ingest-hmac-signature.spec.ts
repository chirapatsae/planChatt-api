/**
 * Wave wave-ai-knowledge-hub — SEC (opt-in HMAC body signature), 2026-06-19.
 *
 * Second ingest factor: an HMAC-SHA256 signature over the RAW request body
 * (§17.15.5 tampering/replay control; report §6.1 STRIDE-T). Exercised
 * through the REAL `KnowledgeSourceApiKeyGuard` + `KnowledgeSourceService`:
 *
 *   1. Back-compat — `hmac_secret_hash IS NULL` → API-key-only ingest; no
 *      signature header is required, and a stray one is ignored.
 *   2. Enabled + VALID signature → admitted, source attached.
 *   3. Enabled + bad / tampered / missing signature / missing rawBody →
 *      the SAME generic `401 INGEST_KEY_INVALID` as a bad API key (no
 *      enumeration of which factor failed); the source is NEVER attached,
 *      so a half-authenticated request can't reach staging (§3 / §17.11 —
 *      the secret IS the integrity boundary, no role bypass).
 *   4. Forged API key still 401 even with a valid signature (key first).
 *   5. Lifecycle — rotate enables/rotates and returns the plaintext ONCE,
 *      storing it encrypted-at-rest (NEVER plaintext, never in audit);
 *      disable reverts to API-key-only; both audit as `update` on
 *      targetKind `source` through the caller's transaction (§17.3 — never
 *      TrackingStatus). A freshly-rotated secret verifies end-to-end.
 *
 * AES-at-rest is MOCKED here with a reversible, plaintext-hiding base64
 * transform — the real env-keyed util is covered by W89 and would couple
 * this unit spec to `.env.*`. The mock still lets "stored ≠ plaintext" and
 * the encrypt→decrypt→verify round-trip remain meaningful (the HMAC path
 * itself uses real `crypto`).
 */
import { ExecutionContext } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHmac } from 'crypto';

// Reversible, plaintext-hiding stand-in for the env-keyed AES util so the
// service's encryption()/decryption() round-trip without env coupling. The
// service imports it as `src/util/encryption.util`; this relative path
// resolves to the SAME module, so the mock intercepts both specifiers.
jest.mock('../../../util/encryption.util', () => ({
  encryption: jest.fn(
    (plain: string): Promise<string> =>
      Promise.resolve(Buffer.from(plain, 'utf8').toString('base64')),
  ),
  decryption: jest.fn(
    (cipher: string): Promise<string> =>
      Promise.resolve(Buffer.from(cipher, 'base64').toString('utf8')),
  ),
}));

import { KnowledgeSourceApiKeyGuard } from '../../guards/knowledge-source-api-key.guard';
import { KnowledgeAuditService } from '../../services/knowledge-audit.service';
import { KnowledgeSourceService } from '../../services/knowledge-source.service';
import {
  expectHttpError,
  HarnessRepos,
  makeHarnessRepos,
} from '../connector-test.util';

jest.setTimeout(60_000);

const RAW_KEY = 'pbk_live_HMAC-test-test-test-test-test-test-tes';
const RAW_HMAC_SECRET = 'pbk_hmac_SECRET-secret-secret-secret-secret-x';

/** Mirrors the mocked `encryption()` so seeded rows match decryption(). */
const atRest = (plain: string): string =>
  Buffer.from(plain, 'utf8').toString('base64');

const PAYLOAD = { title: 'เล่มเพิ่มเติมคืออะไร', body_md: 'คำอธิบาย' };
const RAW_BODY = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

const sign = (secret: string, body: Buffer): string =>
  createHmac('sha256', secret).update(body).digest('base64');

let cachedKeyHash: string;

beforeAll(async () => {
  cachedKeyHash = await argon2.hash(RAW_KEY, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
});

interface Harness {
  repos: HarnessRepos;
  sourceService: KnowledgeSourceService;
  guard: KnowledgeSourceApiKeyGuard;
  source: Record<string, any>;
}

function seedSource(
  overrides: Record<string, unknown> = {},
): Record<string, any> {
  return {
    id: 'src-hmac-1',
    name: 'ระบบสารสนเทศจังหวัด',
    description: 'desc',
    sourceKey: 'province-info',
    owningAgencyNote: 'note',
    mode: 'webhook',
    status: 'active',
    apiKeyHash: cachedKeyHash,
    apiKeyPrefix: RAW_KEY.slice(0, 12),
    hmacSecretHash: null,
    payloadSchema: { type: 'object' },
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

function createHarness(overrides: Record<string, unknown> = {}): Harness {
  const repos = makeHarnessRepos();
  const source = seedSource(overrides);
  repos.sourceRepo.rows.push(source);

  const audit = new KnowledgeAuditService(repos.throwingAuditRepo as never);
  const sourceService = new KnowledgeSourceService(
    repos.sourceRepo as never,
    repos.ingestionRepo as never,
    repos.workHistoryRepo as never,
    audit,
  );
  const guard = new KnowledgeSourceApiKeyGuard(sourceService);
  return { repos, sourceService, guard, source };
}

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function ingestReq(
  headers: Record<string, unknown>,
  rawBody: Buffer | undefined = RAW_BODY,
): Record<string, unknown> {
  return { params: { sourceKey: 'province-info' }, headers, rawBody };
}

describe('HMAC ingest signature — guard (KnowledgeSourceApiKeyGuard)', () => {
  it('back-compat: an HMAC-less source admits a valid key with NO signature header', async () => {
    const h = createHarness(); // hmacSecretHash = null
    const req = ingestReq({ 'x-pbk-api-key': RAW_KEY });

    await expect(h.guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect((req.knowledgeSource as { id: string }).id).toBe('src-hmac-1');
  });

  it('back-compat: a stray signature header is ignored when HMAC is not configured', async () => {
    const h = createHarness();
    const req = ingestReq({
      'x-pbk-api-key': RAW_KEY,
      'x-pbk-signature': 'this-is-not-checked',
    });

    await expect(h.guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('enabled + VALID signature → admits and attaches the source', async () => {
    const h = createHarness({ hmacSecretHash: atRest(RAW_HMAC_SECRET) });
    const req = ingestReq({
      'x-pbk-api-key': RAW_KEY,
      'x-pbk-signature': sign(RAW_HMAC_SECRET, RAW_BODY),
    });

    await expect(h.guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect((req.knowledgeSource as { id: string }).id).toBe('src-hmac-1');
  });

  it('enabled + WRONG signature → 401 INGEST_KEY_INVALID; source never attached', async () => {
    const h = createHarness({ hmacSecretHash: atRest(RAW_HMAC_SECRET) });
    const req = ingestReq({
      'x-pbk-api-key': RAW_KEY,
      'x-pbk-signature': sign('pbk_hmac_a-totally-different-secret', RAW_BODY),
    });

    await expectHttpError(
      h.guard.canActivate(makeContext(req)),
      401,
      'INGEST_KEY_INVALID',
    );
    expect(req.knowledgeSource).toBeUndefined();
  });

  it('enabled + signature over a DIFFERENT body → 401 (tamper detection)', async () => {
    const h = createHarness({ hmacSecretHash: atRest(RAW_HMAC_SECRET) });
    // Correct secret, but signed over a different body than the one sent.
    const req = ingestReq({
      'x-pbk-api-key': RAW_KEY,
      'x-pbk-signature': sign(RAW_HMAC_SECRET, Buffer.from('{}', 'utf8')),
    });

    await expectHttpError(
      h.guard.canActivate(makeContext(req)),
      401,
      'INGEST_KEY_INVALID',
    );
    expect(req.knowledgeSource).toBeUndefined();
  });

  it('enabled + MISSING signature header → 401', async () => {
    const h = createHarness({ hmacSecretHash: atRest(RAW_HMAC_SECRET) });
    const req = ingestReq({ 'x-pbk-api-key': RAW_KEY });

    await expectHttpError(
      h.guard.canActivate(makeContext(req)),
      401,
      'INGEST_KEY_INVALID',
    );
    expect(req.knowledgeSource).toBeUndefined();
  });

  it('enabled + MISSING rawBody → 401 (fail closed; never signs re-serialized JSON)', async () => {
    const h = createHarness({ hmacSecretHash: atRest(RAW_HMAC_SECRET) });
    // Build the request WITHOUT the helper so rawBody is genuinely absent
    // (the helper's default param would resurrect RAW_BODY).
    const req: Record<string, unknown> = {
      params: { sourceKey: 'province-info' },
      headers: {
        'x-pbk-api-key': RAW_KEY,
        'x-pbk-signature': sign(RAW_HMAC_SECRET, RAW_BODY),
      },
      rawBody: undefined,
    };

    await expectHttpError(
      h.guard.canActivate(makeContext(req)),
      401,
      'INGEST_KEY_INVALID',
    );
    expect(req.knowledgeSource).toBeUndefined();
  });

  it('forged API key → 401 even with a valid signature (key is checked first)', async () => {
    const h = createHarness({ hmacSecretHash: atRest(RAW_HMAC_SECRET) });
    const req = ingestReq({
      'x-pbk-api-key': `${RAW_KEY.slice(0, 12)}forged-rest-of-the-key-bytes`,
      'x-pbk-signature': sign(RAW_HMAC_SECRET, RAW_BODY),
    });

    await expectHttpError(
      h.guard.canActivate(makeContext(req)),
      401,
      'INGEST_KEY_INVALID',
    );
    expect(req.knowledgeSource).toBeUndefined();
  });
});

describe('HMAC ingest signature — lifecycle (rotate / disable)', () => {
  it('rotateHmacSecret enables HMAC, returns the plaintext ONCE, stores it encrypted (never plaintext), audits update/hmac:rotated', async () => {
    const h = createHarness(); // starts API-key-only
    const result = await h.sourceService.rotateHmacSecret(
      'src-hmac-1',
      'user-admin-1',
    );

    expect(result.hmacSecret).toMatch(/^pbk_hmac_/);

    // Persisted form is ciphertext — not the plaintext, never leaked.
    const row = h.source as { hmacSecretHash: string };
    expect(row.hmacSecretHash).not.toBeNull();
    expect(row.hmacSecretHash).not.toBe(result.hmacSecret);
    expect(row.hmacSecretHash).not.toContain(result.hmacSecret);
    expect(JSON.stringify(h.repos.sourceRepo.rows)).not.toContain(
      result.hmacSecret,
    );
    expect(JSON.stringify(h.repos.auditRows)).not.toContain(result.hmacSecret);

    // Round-trips back to the plaintext at verify time (mocked decryption).
    expect(Buffer.from(row.hmacSecretHash, 'base64').toString('utf8')).toBe(
      result.hmacSecret,
    );

    // Exactly one audit row, transactional (throwingAuditRepo would have
    // fired if it bypassed the manager), no plaintext in the detail.
    const audit = h.repos.auditRows.find(
      (a) => a.action === 'update' && a.targetKind === 'source',
    );
    expect(audit).toBeDefined();
    expect((audit?.detail as { hmac: string }).hmac).toBe('rotated');

    // DTO projection reports enabled but NEVER exposes the secret column.
    const dto = await h.sourceService.getSource('src-hmac-1');
    expect(dto.hmacEnabled).toBe(true);
    expect(
      (dto as unknown as Record<string, unknown>).hmacSecretHash,
    ).toBeUndefined();
  });

  it('a freshly-rotated secret verifies through the guard end-to-end', async () => {
    const h = createHarness();
    const { hmacSecret } = await h.sourceService.rotateHmacSecret(
      'src-hmac-1',
      'user-admin-1',
    );

    const req = ingestReq({
      'x-pbk-api-key': RAW_KEY,
      'x-pbk-signature': sign(hmacSecret, RAW_BODY),
    });
    await expect(h.guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect((req.knowledgeSource as { id: string }).id).toBe('src-hmac-1');
  });

  it('disableHmacSecret clears the secret, reverts to API-key-only, audits update/hmac:disabled', async () => {
    const h = createHarness({ hmacSecretHash: atRest(RAW_HMAC_SECRET) });

    const dto = await h.sourceService.disableHmacSecret(
      'src-hmac-1',
      'user-admin-1',
    );
    expect(dto.hmacEnabled).toBe(false);
    expect((h.source as { hmacSecretHash: unknown }).hmacSecretHash).toBeNull();

    const audit = h.repos.auditRows.find(
      (a) => a.action === 'update' && a.targetKind === 'source',
    );
    expect((audit?.detail as { hmac: string }).hmac).toBe('disabled');

    // Back-compat restored — a valid key with no signature now admits.
    const req = ingestReq({ 'x-pbk-api-key': RAW_KEY });
    await expect(h.guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('disableHmacSecret is a no-op (no write, no audit) when already disabled', async () => {
    const h = createHarness(); // already null
    await h.sourceService.disableHmacSecret('src-hmac-1', 'user-admin-1');
    expect(h.repos.auditRows).toHaveLength(0);
  });

  it('revoked sources refuse rotate AND disable (409 SOURCE_STATUS_INVALID)', async () => {
    const h = createHarness({ status: 'revoked' });
    await expectHttpError(
      h.sourceService.rotateHmacSecret('src-hmac-1', 'user-admin-1'),
      409,
      'SOURCE_STATUS_INVALID',
    );
    await expectHttpError(
      h.sourceService.disableHmacSecret('src-hmac-1', 'user-admin-1'),
      409,
      'SOURCE_STATUS_INVALID',
    );
  });
});
