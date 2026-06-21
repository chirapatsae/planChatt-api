import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { decryption, encryption } from 'src/util/encryption.util';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  CreateKnowledgeSourceDto,
  KnowledgeSourceCreatedDto,
  KnowledgeSourceDto,
  KnowledgeSourceHealthDto,
  KnowledgeSourceListResponseDto,
  KnowledgeSourceRotateHmacResponseDto,
  KnowledgeSourceRotateKeyResponseDto,
  UpdateKnowledgeSourceDto,
} from '../dto/knowledge-source.dto';
import {
  AiKnowledgeIngestion,
  AiKnowledgeIngestionStatus,
} from '../entities/ai-knowledge-ingestion.entity';
import { AiKnowledgeSource } from '../entities/ai-knowledge-source.entity';
import { ALL_KNOWLEDGE_DOMAIN_KEYS } from '../registry/derived-domain-map';
import { KnowledgeAuditService } from './knowledge-audit.service';

/** Fixed key namespace prefix — `pbk_live_` + 43-char base64url body. */
const API_KEY_NAMESPACE = 'pbk_live_';
/** Stored lookup prefix length (matches the varchar(12) column). */
const API_KEY_PREFIX_LENGTH = 12;

/** Fixed HMAC-secret namespace prefix — `pbk_hmac_` + 43-char base64url. */
const HMAC_SECRET_NAMESPACE = 'pbk_hmac_';

/**
 * Argon2id parameters for API-KEY digests (NOT passwords). The key body
 * is 32 server-generated random bytes (≈256-bit entropy), so offline
 * brute force is computationally infeasible regardless of hash cost —
 * the digest exists to keep a DB leak from yielding usable credentials
 * (STRIDE-S, report §6.1). OWASP "interactive" cost is therefore
 * appropriate here; the heavyweight 128 MiB backup-login profile
 * (`argon2.service.ts`) is for low-entropy human passwords and would
 * add ~500 ms to EVERY authenticated ingest request.
 */
const API_KEY_HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

interface KnowledgeActor {
  workHistoryId: string;
  roleName: string;
}

interface SourceHealthRow {
  sourceId: string;
  status: AiKnowledgeIngestionStatus;
  count: string;
}

/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * KnowledgeSourceService — connector-source lifecycle (register →
 * 4-eyes approve → active → suspend / revoke, key rotation) plus the
 * API-key authentication used by `KnowledgeSourceApiKeyGuard`.
 *
 * CLAUDE.md references:
 *   - §17.15.5 — hashed credentials: server-generated key shown ONCE,
 *     stored as argon2 digest + lookup prefix; rotate + revoke; the key
 *     is NEVER logged and NEVER recoverable (§17.15.7 — no role may
 *     read a stored key, only rotate).
 *   - §17.15.5 — 4-eyes source approval: creator ≠ approver, service-
 *     enforced (403 SOURCE_FOUR_EYES_REQUIRED). No role exemption
 *     (§17.11) — a super-admin creator still cannot self-approve.
 *   - §17.3 — every mutation writes ONE `ai_knowledge_audit_logs` row
 *     inside the same transaction; NEVER TrackingStatus. Actors are
 *     WorkHistory UUIDs without referential integrity.
 *   - Q3 LOCKED — `mode` is server-forced to `webhook`; the `pull`
 *     enum value stays unused until a future clause activates it.
 *   - Q4 LOCKED — classification ceiling ≤ `internal` (the enum value
 *     set itself has no higher tier).
 */
@Injectable()
export class KnowledgeSourceService {
  constructor(
    @InjectRepository(AiKnowledgeSource)
    private readonly sourceRepository: Repository<AiKnowledgeSource>,
    @InjectRepository(AiKnowledgeIngestion)
    private readonly ingestionRepository: Repository<AiKnowledgeIngestion>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    private readonly knowledgeAuditService: KnowledgeAuditService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Admin console — reads (ZERO-write, §18.13 discipline)
  // ──────────────────────────────────────────────────────────────────

  async listSources(): Promise<KnowledgeSourceListResponseDto> {
    const sources = await this.sourceRepository.find({
      order: { createdAt: 'DESC' },
    });
    const healthBySource = await this.loadHealthCounters(
      sources.map((source) => source.id),
    );
    return {
      items: sources.map((source) =>
        this.toSourceDto(source, healthBySource.get(source.id)),
      ),
      total: sources.length,
    };
  }

  async getSource(id: string): Promise<KnowledgeSourceDto> {
    const source = await this.loadSourceOrThrow(id);
    const healthBySource = await this.loadHealthCounters([source.id]);
    return this.toSourceDto(source, healthBySource.get(source.id));
  }

  // ──────────────────────────────────────────────────────────────────
  // Admin console — lifecycle mutations (ADMIN_OR_ABOVE via controller)
  // ──────────────────────────────────────────────────────────────────

  /**
   * `POST /sources` — register a source at `pending_approval`.
   *
   * Generates the 32-byte API key server-side; the PLAINTEXT appears in
   * exactly this one response (acceptance §6) — only the argon2 digest
   * + 12-char lookup prefix are persisted, and the plaintext is never
   * passed to any logger.
   */
  async createSource(
    dto: CreateKnowledgeSourceDto,
    userId: string,
  ): Promise<KnowledgeSourceCreatedDto> {
    const actor = await this.resolveActor(userId);
    this.assertKnownDomainKey(dto.targetDomainKey);

    const existing = await this.sourceRepository.findOne({
      where: { sourceKey: dto.sourceKey },
      withDeleted: true,
    });
    if (existing) {
      throw new ConflictException({
        code: 'SOURCE_KEY_TAKEN',
        message: 'sourceKey นี้ถูกใช้แล้ว กรุณาเลือกชื่ออื่น',
      });
    }

    const { plaintext, prefix, hash } = await this.generateApiKey();

    const saved = await this.sourceRepository.manager.transaction(
      async (manager) => {
        const repo = manager.getRepository(AiKnowledgeSource);
        const row = await repo.save(
          repo.create({
            name: dto.name,
            description: dto.description,
            sourceKey: dto.sourceKey,
            owningAgencyNote: dto.owningAgencyNote,
            // Q3 LOCKED — server-forced webhook; never client-supplied.
            mode: 'webhook' as const,
            status: 'pending_approval' as const,
            apiKeyHash: hash,
            apiKeyPrefix: prefix,
            hmacSecretHash: null,
            payloadSchema: dto.payloadSchema,
            targetDomainKey: dto.targetDomainKey,
            classificationCeiling: dto.classificationCeiling ?? 'internal',
            rateLimitPerMin: dto.rateLimitPerMin ?? 60,
            maxPayloadBytes: dto.maxPayloadBytes ?? 262144,
            purposeDeclaration: dto.purposeDeclaration,
            lawfulBasis: dto.lawfulBasis,
            createdByWorkHistoryId: actor.workHistoryId,
            approvedByWorkHistoryId: null,
            approvedAt: null,
            lastSeenAt: null,
          }),
        );

        await this.knowledgeAuditService.record(
          {
            actorWorkHistoryId: actor.workHistoryId,
            actorRole: actor.roleName,
            action: 'source_create',
            targetKind: 'source',
            targetId: row.id,
            // Audit detail carries the NON-secret prefix only — never
            // the plaintext or the digest.
            detail: { sourceKey: row.sourceKey, apiKeyPrefix: prefix },
          },
          manager,
        );

        return row;
      },
    );

    return {
      source: this.toSourceDto(saved, undefined),
      apiKey: plaintext,
    };
  }

  /**
   * `POST /sources/:id/approve` — 4-eyes activation.
   *
   * - approver MUST differ from creator → 403 SOURCE_FOUR_EYES_REQUIRED
   *   (no role exemption, §17.11 — super-admin creators included)
   * - PDPA purpose / lawful-basis must be non-empty → 422 (docs/pdpa/07
   *   DPO sign-off precedes activation; empty declarations cannot have
   *   been signed off)
   * - only `pending_approval` sources can be approved → 409
   */
  async approveSource(id: string, userId: string): Promise<KnowledgeSourceDto> {
    const actor = await this.resolveActor(userId);
    const source = await this.loadSourceOrThrow(id);

    if (source.status !== 'pending_approval') {
      throw this.sourceStatusInvalid(source.status, 'approve');
    }
    if (source.createdByWorkHistoryId === actor.workHistoryId) {
      throw new ForbiddenException({
        code: 'SOURCE_FOUR_EYES_REQUIRED',
        message:
          'ผู้อนุมัติแหล่งข้อมูลต้องไม่ใช่ผู้สร้าง (กฎ 4-eyes) กรุณาให้ผู้ดูแลระบบท่านอื่นเป็นผู้อนุมัติ',
      });
    }
    if (
      !source.purposeDeclaration?.trim() ||
      !source.lawfulBasis?.trim()
    ) {
      throw new UnprocessableEntityException({
        code: 'SOURCE_PDPA_FIELDS_REQUIRED',
        message:
          'ต้องระบุวัตถุประสงค์การประมวลผลและฐานทางกฎหมาย (PDPA) ก่อนอนุมัติแหล่งข้อมูล',
      });
    }

    const approvedAt = new Date();
    await this.sourceRepository.manager.transaction(async (manager) => {
      await manager.getRepository(AiKnowledgeSource).update(
        { id },
        {
          status: 'active',
          approvedByWorkHistoryId: actor.workHistoryId,
          approvedAt,
        },
      );
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'source_approve',
          targetKind: 'source',
          targetId: id,
          detail: { from: 'pending_approval', to: 'active' },
        },
        manager,
      );
    });

    return this.toSourceDto(
      {
        ...source,
        status: 'active',
        approvedByWorkHistoryId: actor.workHistoryId,
        approvedAt,
      },
      undefined,
    );
  }

  /** `POST /sources/:id/suspend` — active → suspended (reversible). */
  async suspendSource(id: string, userId: string): Promise<KnowledgeSourceDto> {
    return this.transitionSourceStatus(id, userId, {
      from: ['active'],
      to: 'suspended',
      action: 'source_suspend',
    });
  }

  /**
   * `POST /sources/:id/revoke` — terminal kill switch. Allowed from any
   * non-revoked status; a revoked source can never ingest again and its
   * key cannot be rotated back to life.
   */
  async revokeSource(id: string, userId: string): Promise<KnowledgeSourceDto> {
    return this.transitionSourceStatus(id, userId, {
      from: ['pending_approval', 'active', 'suspended'],
      to: 'revoked',
      action: 'source_revoke',
    });
  }

  /**
   * `POST /sources/:id/rotate-key` — replaces the credential. The NEW
   * plaintext appears once in this response; the OLD key stops working
   * the instant the transaction commits. Forbidden on revoked sources
   * (revocation is terminal).
   */
  async rotateKey(
    id: string,
    userId: string,
  ): Promise<KnowledgeSourceRotateKeyResponseDto> {
    const actor = await this.resolveActor(userId);
    const source = await this.loadSourceOrThrow(id);

    if (source.status === 'revoked') {
      throw this.sourceStatusInvalid(source.status, 'rotate-key');
    }

    const { plaintext, prefix, hash } = await this.generateApiKey();

    await this.sourceRepository.manager.transaction(async (manager) => {
      await manager
        .getRepository(AiKnowledgeSource)
        .update({ id }, { apiKeyHash: hash, apiKeyPrefix: prefix });
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'source_rotate_key',
          targetKind: 'source',
          targetId: id,
          detail: { apiKeyPrefix: prefix },
        },
        manager,
      );
    });

    return { id, apiKey: plaintext, apiKeyPrefix: prefix };
  }

  /**
   * `POST /sources/:id/rotate-hmac-secret` — enable (first call) or rotate
   * the optional HMAC body-signature secret. The NEW plaintext appears
   * once in this response; the OLD secret stops verifying the instant the
   * transaction commits. Stored AES-encrypted-at-rest (reversible — the
   * server must recompute `HMAC(secret, rawBody)` at receipt; see the
   * `hmacSecretHash` entity note). Forbidden on revoked sources, mirroring
   * `rotateKey`. Audited as `update` on targetKind `source` (the audit
   * action enum is a PG enum — widening it under synchronize:true is the
   * documented footgun; the generic `update` + a `detail` discriminator is
   * the established no-churn convention, same as `updateSource`).
   */
  async rotateHmacSecret(
    id: string,
    userId: string,
  ): Promise<KnowledgeSourceRotateHmacResponseDto> {
    const actor = await this.resolveActor(userId);
    const source = await this.loadSourceOrThrow(id);

    if (source.status === 'revoked') {
      throw this.sourceStatusInvalid(source.status, 'rotate-hmac-secret');
    }

    const secret = this.generateHmacSecret();
    const ciphertext = await encryption(secret);

    await this.sourceRepository.manager.transaction(async (manager) => {
      await manager
        .getRepository(AiKnowledgeSource)
        .update({ id }, { hmacSecretHash: ciphertext });
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'update',
          targetKind: 'source',
          // NON-secret discriminator only — never the plaintext / ciphertext.
          detail: { hmac: 'rotated' },
          targetId: id,
        },
        manager,
      );
    });

    return { id, hmacSecret: secret };
  }

  /**
   * `POST /sources/:id/disable-hmac-secret` — opt back out (HMAC → off).
   * Clears the secret so the source returns to API-key-only ingest
   * (back-compat path). Idempotent: a no-op when already disabled (no
   * write, no audit row). Forbidden on revoked sources.
   */
  async disableHmacSecret(
    id: string,
    userId: string,
  ): Promise<KnowledgeSourceDto> {
    const actor = await this.resolveActor(userId);
    const source = await this.loadSourceOrThrow(id);

    if (source.status === 'revoked') {
      throw this.sourceStatusInvalid(source.status, 'disable-hmac-secret');
    }

    if (source.hmacSecretHash !== null) {
      await this.sourceRepository.manager.transaction(async (manager) => {
        await manager
          .getRepository(AiKnowledgeSource)
          .update({ id }, { hmacSecretHash: null });
        await this.knowledgeAuditService.record(
          {
            actorWorkHistoryId: actor.workHistoryId,
            actorRole: actor.roleName,
            action: 'update',
            targetKind: 'source',
            detail: { hmac: 'disabled' },
            targetId: id,
          },
          manager,
        );
      });
    }

    return this.toSourceDto({ ...source, hmacSecretHash: null }, undefined);
  }

  /**
   * `PATCH /sources/:id` — schema / rate-limit / domain / descriptive
   * edits. NOT status (dedicated endpoints), NOT mode (Q3), NOT
   * credentials (rotate-key only). Forbidden on revoked sources.
   * Audited as `update` on targetKind `source` (the audit-action enum
   * pre-declared only the lifecycle `source_*` values; widening a PG
   * enum under synchronize:true is the documented footgun, and the
   * generic `update` + targetKind discriminator is unambiguous).
   */
  async updateSource(
    id: string,
    dto: UpdateKnowledgeSourceDto,
    userId: string,
  ): Promise<KnowledgeSourceDto> {
    const actor = await this.resolveActor(userId);
    const source = await this.loadSourceOrThrow(id);

    if (source.status === 'revoked') {
      throw this.sourceStatusInvalid(source.status, 'update');
    }
    if (dto.targetDomainKey !== undefined) {
      this.assertKnownDomainKey(dto.targetDomainKey);
    }

    const patch: Partial<AiKnowledgeSource> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.owningAgencyNote !== undefined) {
      patch.owningAgencyNote = dto.owningAgencyNote;
    }
    if (dto.payloadSchema !== undefined) {
      patch.payloadSchema = dto.payloadSchema;
    }
    if (dto.targetDomainKey !== undefined) {
      patch.targetDomainKey = dto.targetDomainKey;
    }
    if (dto.rateLimitPerMin !== undefined) {
      patch.rateLimitPerMin = dto.rateLimitPerMin;
    }
    if (dto.maxPayloadBytes !== undefined) {
      patch.maxPayloadBytes = dto.maxPayloadBytes;
    }
    if (dto.purposeDeclaration !== undefined) {
      patch.purposeDeclaration = dto.purposeDeclaration;
    }
    if (dto.lawfulBasis !== undefined) patch.lawfulBasis = dto.lawfulBasis;

    if (Object.keys(patch).length > 0) {
      await this.sourceRepository.manager.transaction(async (manager) => {
        // jsonb columns don't unify with QueryDeepPartialEntity's
        // recursive-partial shape — boundary cast, same convention as
        // `knowledge-audit.service.ts`.
        await manager
          .getRepository(AiKnowledgeSource)
          .update({ id }, patch as QueryDeepPartialEntity<AiKnowledgeSource>);
        await this.knowledgeAuditService.record(
          {
            actorWorkHistoryId: actor.workHistoryId,
            actorRole: actor.roleName,
            action: 'update',
            targetKind: 'source',
            targetId: id,
            detail: { changedFields: Object.keys(patch) },
          },
          manager,
        );
      });
    }

    const healthBySource = await this.loadHealthCounters([id]);
    return this.toSourceDto(
      { ...source, ...patch },
      healthBySource.get(id),
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Ingest authentication (consumed by KnowledgeSourceApiKeyGuard)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Authenticate an inbound `POST /ingest/:sourceKey` request.
   *
   * NO JWT, NO session, NO role context (task §3.2) — the ONLY identity
   * is the per-source API key:
   *
   *   1. prefix lookup (first 12 chars) over non-deleted sources;
   *   2. argon2 verify against each prefix candidate (argon2's verify is
   *      internally constant-time over the digest; candidate fan-out is
   *      bounded by prefix collisions, in practice 1);
   *   3. the matched source's `sourceKey` MUST equal the URL param —
   *      mismatch answers the same 401 as a bad key (no enumeration);
   *   4. status MUST be `active` → otherwise 403 (forged / revoked /
   *      suspended keys NEVER touch staging — acceptance §6);
   *   5. mode MUST be `webhook` (Q3 — defensive; `pull` is pre-declared
   *      but inert).
   *
   * On the no-candidate path a dummy verify equalizes timing
   * (anti-enumeration, same posture as `argon2.service.ts` verifyDummy).
   */
  async authenticateForIngest(
    sourceKeyParam: string | undefined,
    rawKey: string | undefined,
  ): Promise<AiKnowledgeSource> {
    if (
      !rawKey ||
      rawKey.length < API_KEY_PREFIX_LENGTH ||
      rawKey.length > 128 ||
      !sourceKeyParam
    ) {
      throw this.ingestKeyInvalid();
    }

    const prefix = rawKey.slice(0, API_KEY_PREFIX_LENGTH);
    const candidates = await this.sourceRepository.find({
      where: { apiKeyPrefix: prefix },
    });

    let matched: AiKnowledgeSource | null = null;
    for (const candidate of candidates) {
      if (await this.verifyApiKey(candidate.apiKeyHash, rawKey)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      await this.verifyDummy(rawKey);
      throw this.ingestKeyInvalid();
    }
    if (matched.sourceKey !== sourceKeyParam) {
      // Valid key, wrong URL — answer exactly like a bad key so the
      // caller cannot probe other sources' slugs with their own key.
      throw this.ingestKeyInvalid();
    }
    if (matched.status !== 'active') {
      throw new ForbiddenException({
        code: 'INGEST_SOURCE_NOT_ACTIVE',
        message: 'แหล่งข้อมูลนี้ยังไม่เปิดใช้งาน หรือถูกระงับ/เพิกถอนแล้ว',
      });
    }
    if (matched.mode !== 'webhook') {
      throw new ForbiddenException({
        code: 'INGEST_MODE_UNSUPPORTED',
        message: 'แหล่งข้อมูลนี้ไม่รองรับการส่งข้อมูลแบบ webhook',
      });
    }
    return matched;
  }

  /**
   * Optional second ingest factor — HMAC-SHA256 body-signature check
   * (§17.15.5 tampering/replay control; report §6.1 STRIDE-T). Called by
   * `KnowledgeSourceApiKeyGuard` AFTER the API key has authenticated the
   * source, BEFORE any staging write.
   *
   *   - `hmac_secret_hash IS NULL` → HMAC not configured → no-op
   *     (back-compat: API-key-only sources are unaffected).
   *   - otherwise the request MUST carry
   *     `X-PBK-Signature: base64(HMAC-SHA256(secret, rawRequestBody))`.
   *     The secret is decrypted from rest, the HMAC recomputed over the
   *     EXACT raw bytes (never a re-stringified JSON — that would change
   *     under whitespace / key-order / unicode shifts), and compared in
   *     constant time.
   *
   * EVERY failure shape (missing header, missing rawBody, corrupt stored
   * secret, length mismatch, byte mismatch) answers the SAME generic 401
   * as a bad API key (`ingestKeyInvalid`) — no enumeration of whether the
   * key, the slug, or the signature was the failing factor (task §3). Fail
   * CLOSED: a missing rawBody NEVER falls back to `JSON.stringify(body)`
   * (mirrors `line-signature.guard.ts`).
   */
  async assertValidHmacSignature(
    source: AiKnowledgeSource,
    rawBody: Buffer | undefined,
    providedSignature: string | undefined,
  ): Promise<void> {
    // Opt-in: unconfigured sources keep API-key-only auth.
    if (!source.hmacSecretHash) {
      return;
    }

    if (!providedSignature || typeof providedSignature !== 'string') {
      throw this.ingestKeyInvalid();
    }
    if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      // Fail closed — NEVER sign a re-serialized JSON object.
      throw this.ingestKeyInvalid();
    }

    let secret: string;
    try {
      secret = await decryption(source.hmacSecretHash);
    } catch {
      // Corrupt / undecryptable stored secret — fail closed, no detail leak.
      throw this.ingestKeyInvalid();
    }

    const computed = createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    const expected = Buffer.from(computed, 'utf8');
    const actual = Buffer.from(providedSignature, 'utf8');
    // timingSafeEqual requires equal lengths; a length mismatch is an
    // immediate non-match without leaking the correct-prefix ratio.
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw this.ingestKeyInvalid();
    }
  }

  // ── private helpers ─────────────────────────────────────────────

  /**
   * Generate a fresh credential: `pbk_live_` + base64url(32 random
   * bytes). Returns the plaintext (for the ONE-time response), the
   * 12-char lookup prefix, and the argon2id digest (the only stored
   * form). The plaintext MUST NOT be logged by any caller.
   */
  private async generateApiKey(): Promise<{
    plaintext: string;
    prefix: string;
    hash: string;
  }> {
    const plaintext = `${API_KEY_NAMESPACE}${randomBytes(32).toString('base64url')}`;
    const prefix = plaintext.slice(0, API_KEY_PREFIX_LENGTH);
    const hash = await argon2.hash(plaintext, API_KEY_HASH_OPTIONS);
    return { plaintext, prefix, hash };
  }

  /**
   * Generate a fresh HMAC secret: `pbk_hmac_` + base64url(32 random bytes)
   * (≈256-bit entropy). The plaintext is returned for the ONE-time
   * response and stored only AES-encrypted (see `rotateHmacSecret`). It
   * MUST NOT be logged by any caller.
   */
  private generateHmacSecret(): string {
    return `${HMAC_SECRET_NAMESPACE}${randomBytes(32).toString('base64url')}`;
  }

  /** Fail-closed verify (corrupt digest → false, never throw). */
  private async verifyApiKey(hash: string, rawKey: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, rawKey);
    } catch {
      return false;
    }
  }

  /** Cached dummy digest — timing parity on the no-candidate path. */
  private dummyHash: string | null = null;

  private async verifyDummy(rawKey: string): Promise<void> {
    try {
      if (!this.dummyHash) {
        this.dummyHash = await argon2.hash(
          `__knowledge_ingest_dummy_${Date.now()}_${Math.random()}`,
          API_KEY_HASH_OPTIONS,
        );
      }
      await argon2.verify(this.dummyHash, rawKey);
    } catch {
      // Timing parity only — result discarded.
    }
  }

  private async transitionSourceStatus(
    id: string,
    userId: string,
    options: {
      from: AiKnowledgeSource['status'][];
      to: AiKnowledgeSource['status'];
      action: 'source_suspend' | 'source_revoke';
    },
  ): Promise<KnowledgeSourceDto> {
    const actor = await this.resolveActor(userId);
    const source = await this.loadSourceOrThrow(id);

    if (!options.from.includes(source.status)) {
      throw this.sourceStatusInvalid(source.status, options.action);
    }

    await this.sourceRepository.manager.transaction(async (manager) => {
      await manager
        .getRepository(AiKnowledgeSource)
        .update({ id }, { status: options.to });
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: options.action,
          targetKind: 'source',
          targetId: id,
          detail: { from: source.status, to: options.to },
        },
        manager,
      );
    });

    return this.toSourceDto({ ...source, status: options.to }, undefined);
  }

  private async loadSourceOrThrow(id: string): Promise<AiKnowledgeSource> {
    const source = await this.sourceRepository.findOne({ where: { id } });
    if (!source) {
      throw new NotFoundException({
        code: 'SOURCE_NOT_FOUND',
        message: 'ไม่พบแหล่งข้อมูลที่ระบุ',
      });
    }
    return source;
  }

  /** Grouped staging counters per source (report §4 "Monitoring"). */
  private async loadHealthCounters(
    sourceIds: string[],
  ): Promise<Map<string, KnowledgeSourceHealthDto>> {
    const result = new Map<string, KnowledgeSourceHealthDto>();
    if (sourceIds.length === 0) return result;

    const rows = await this.ingestionRepository
      .createQueryBuilder('ingestion')
      .select('ingestion.sourceId', 'sourceId')
      .addSelect('ingestion.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('ingestion.sourceId IN (:...sourceIds)', { sourceIds })
      .andWhere('ingestion.deletedAt IS NULL')
      .groupBy('ingestion.sourceId')
      .addGroupBy('ingestion.status')
      .getRawMany<SourceHealthRow>();

    for (const row of rows) {
      const health =
        result.get(row.sourceId) ?? this.emptyHealth();
      health[row.status] = Number(row.count) || 0;
      result.set(row.sourceId, health);
    }
    return result;
  }

  private emptyHealth(): KnowledgeSourceHealthDto {
    return { quarantined: 0, rejected: 0, promoted: 0, purged: 0 };
  }

  private async resolveActor(userId: string): Promise<KnowledgeActor> {
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    const workHistory = await this.workHistoryRepository.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role'],
    });
    if (!workHistory) {
      throw new ForbiddenException('WORK_STATUS_NOT_APPROVED');
    }
    return {
      workHistoryId: workHistory.id,
      roleName: workHistory.role?.name ?? '',
    };
  }

  private assertKnownDomainKey(domainKey: string): void {
    if (!ALL_KNOWLEDGE_DOMAIN_KEYS.includes(domainKey)) {
      throw new ConflictException({
        code: 'KNOWLEDGE_DOMAIN_UNKNOWN',
        message: 'ไม่พบหมวดองค์ความรู้ที่ระบุ (targetDomainKey ไม่ถูกต้อง)',
        domainKey,
      });
    }
  }

  private sourceStatusInvalid(
    currentStatus: string,
    operation: string,
  ): ConflictException {
    return new ConflictException({
      code: 'SOURCE_STATUS_INVALID',
      message: 'สถานะแหล่งข้อมูลปัจจุบันไม่อนุญาตให้ทำรายการนี้',
      currentStatus,
      operation,
    });
  }

  /** Generic 401 — identical body for every credential-failure shape. */
  private ingestKeyInvalid(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'INGEST_KEY_INVALID',
      message: 'API key ไม่ถูกต้อง',
    });
  }

  /** API projection — NEVER includes hash columns. */
  private toSourceDto(
    source: AiKnowledgeSource,
    health: KnowledgeSourceHealthDto | undefined,
  ): KnowledgeSourceDto {
    return {
      id: source.id,
      name: source.name,
      description: source.description,
      sourceKey: source.sourceKey,
      owningAgencyNote: source.owningAgencyNote,
      mode: source.mode,
      status: source.status,
      apiKeyPrefix: source.apiKeyPrefix,
      payloadSchema: source.payloadSchema,
      targetDomainKey: source.targetDomainKey,
      classificationCeiling: source.classificationCeiling,
      rateLimitPerMin: source.rateLimitPerMin,
      maxPayloadBytes: source.maxPayloadBytes,
      // Boolean projection ONLY — the secret (ciphertext or plaintext)
      // never leaves the service layer (§17.15.7).
      hmacEnabled: source.hmacSecretHash != null,
      purposeDeclaration: source.purposeDeclaration,
      lawfulBasis: source.lawfulBasis,
      createdByWorkHistoryId: source.createdByWorkHistoryId,
      approvedByWorkHistoryId: source.approvedByWorkHistoryId ?? null,
      approvedAt: this.toIsoOrNull(source.approvedAt),
      lastSeenAt: this.toIsoOrNull(source.lastSeenAt),
      createdAt: this.toIso(source.createdAt),
      updatedAt: this.toIso(source.updatedAt),
      health: health ?? this.emptyHealth(),
    };
  }

  private toIso(value: Date | string | null | undefined): string {
    if (!value) return '';
    return value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();
  }

  private toIsoOrNull(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return this.toIso(value);
  }
}
