import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AiKnowledgeHubService } from '../ai-knowledge-hub.service';
import {
  IngestResponseDto,
  INGESTION_LIST_DEFAULT_LIMIT,
  INGESTION_LIST_MAX_LIMIT,
  KnowledgeIngestionDto,
  KnowledgeIngestionListResponseDto,
  ListKnowledgeIngestionsQueryDto,
  PromoteKnowledgeIngestionDto,
  RejectKnowledgeIngestionDto,
} from '../dto/knowledge-ingestion.dto';
import { KnowledgeEntryDto } from '../dto/list-knowledge-entry.dto';
import { AiKnowledgeIngestion } from '../entities/ai-knowledge-ingestion.entity';
import { AiKnowledgeSource } from '../entities/ai-knowledge-source.entity';
import { KnowledgeAuditService } from './knowledge-audit.service';
import { PiiFlag, scanForPii } from './pii-scan.util';

/**
 * Minimal JSON-Schema-subset validator for source-declared payload
 * schemas (report §4 — "schema-validated against the source's declared
 * schema"). Supported keywords: `type`, `required`, `properties`,
 * `additionalProperties: false`, `items`, `enum`, `minLength`,
 * `maxLength`, `minimum`, `maximum`.
 *
 * Deliberately NO `pattern` support — source schemas are admin-curated,
 * but compiling externally-influenced regexes server-side is a ReDoS
 * vector (report §6.1 STRIDE-D) and the subset above covers the v1
 * connector contracts. A non-object / empty schema accepts everything.
 *
 * Exported for direct spec coverage.
 */
export function validateAgainstDeclaredSchema(
  value: unknown,
  schema: unknown,
  path = '$',
  depth = 0,
): string[] {
  if (depth > 16) return [`${path}: schema nesting too deep`];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return [];
  }
  const s = schema as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof s.type === 'string') {
    const actual = Array.isArray(value)
      ? 'array'
      : value === null
        ? 'null'
        : typeof value;
    const expected = s.type;
    const matches =
      expected === actual ||
      (expected === 'integer' &&
        actual === 'number' &&
        Number.isInteger(value as number));
    if (!matches) {
      errors.push(`${path}: expected type ${expected}, got ${actual}`);
      return errors; // Type mismatch — deeper keywords are meaningless.
    }
  }

  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) {
    errors.push(`${path}: value not in enum`);
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      errors.push(`${path}: shorter than minLength ${s.minLength}`);
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      errors.push(`${path}: longer than maxLength ${s.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      errors.push(`${path}: below minimum ${s.minimum}`);
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      errors.push(`${path}: above maximum ${s.maximum}`);
    }
  }

  if (Array.isArray(value) && s.items && typeof s.items === 'object') {
    value.forEach((item, index) => {
      errors.push(
        ...validateAgainstDeclaredSchema(
          item,
          s.items,
          `${path}[${index}]`,
          depth + 1,
        ),
      );
    });
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties =
      s.properties && typeof s.properties === 'object'
        ? (s.properties as Record<string, unknown>)
        : {};

    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === 'string' && !(key in obj)) {
          errors.push(`${path}: missing required property '${key}'`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in obj) {
        errors.push(
          ...validateAgainstDeclaredSchema(
            obj[key],
            childSchema,
            `${path}.${key}`,
            depth + 1,
          ),
        );
      }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`${path}: unexpected property '${key}'`);
        }
      }
    }
  }

  return errors;
}

interface RateWindow {
  windowStartMs: number;
  count: number;
}

interface KnowledgeActor {
  workHistoryId: string;
  roleName: string;
}

/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * KnowledgeIngestionService — quarantine staging writer + admin review
 * (promote / reject) for the external connector channel.
 *
 * CLAUDE.md references:
 *   - §17.15.5 quarantine-only landing — `ingest()` writes the staging
 *     table ONLY. It NEVER touches `ai_knowledge_entries`, NEVER any
 *     prompt path, NEVER TrackingStatus (§17.3). Promotion (admin,
 *     4-eyes-approved source + explicit human verdict) is the SOLE
 *     bridge into curated entries — and even then the entry is born
 *     `draft` (never auto-published).
 *   - §17.15.5 / Q4 — PII categorically forbidden: the pattern scan
 *     records `pii_flags` at receipt, and `promote()` re-scans the
 *     EFFECTIVE mapped fields, throwing 422 INGEST_PII_BLOCKED until
 *     the offending content is removed/masked via overrides.
 *   - §17.8 envelope shape — the per-source rate limit answers 429
 *     `{ code: 'INGEST_RATE_LIMITED', retryAfterSeconds }`. This is a
 *     per-source ingest limit, NOT a §17.8 AI cooldown key (§17.15.8).
 *   - Idempotency — required `X-Idempotency-Key`, unique per source; a
 *     duplicate returns the ORIGINAL row, never re-inserts (UNIQUE
 *     constraint is the DB-level race backstop).
 *
 * LEAST-PRIVILEGE POSTURE (task §3.5 — ops note): in production the
 * ingest route SHOULD run on a dedicated DB role limited to INSERT on
 * `ai_knowledge_ingestions` + SELECT/UPDATE(last_seen_at) on
 * `ai_knowledge_sources`. The dev/single-connection-pool reality means
 * this process-level split is not enforced here; the CODE-level
 * containment (no JWT identity, staging-only writes, guard-scoped
 * capability) is the in-app half of that posture. Flagged for ops in
 * `docs/tasks/wave-ai-knowledge-hub/BE-03.md`.
 */
@Injectable()
export class KnowledgeIngestionService {
  /**
   * In-memory fixed-window rate state per source id. Same pragmatic
   * posture as the §17.8 in-memory cooldown stores (por03 print) —
   * single-process Phase A infra; a multi-instance deployment would
   * move this to Redis (report §5 Phase C trigger).
   */
  private readonly rateWindows = new Map<string, RateWindow>();

  private static readonly RATE_WINDOW_MS = 60_000;
  private static readonly RATE_STORE_CAP = 10_000;

  constructor(
    @InjectRepository(AiKnowledgeIngestion)
    private readonly ingestionRepository: Repository<AiKnowledgeIngestion>,
    @InjectRepository(AiKnowledgeSource)
    private readonly sourceRepository: Repository<AiKnowledgeSource>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    private readonly knowledgeAuditService: KnowledgeAuditService,
    /** BE-02 service — the promotion target (`origin='external'`). */
    private readonly knowledgeHubService: AiKnowledgeHubService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Ingest (API-key-authenticated source; NO app identity)
  // ──────────────────────────────────────────────────────────────────

  /**
   * `POST /ingest/:sourceKey` — staging-only write.
   *
   * Order of checks (cheap → expensive, nothing mutates before all
   * pass): rate limit → idempotency-key presence → payload-size cap →
   * idempotent replay short-circuit → schema validation + PII scan →
   * INSERT (`quarantined` or `rejected`) → `last_seen_at` touch.
   */
  async ingest(
    source: AiKnowledgeSource,
    payload: unknown,
    idempotencyKey: string | undefined,
    remoteIp: string | null,
  ): Promise<IngestResponseDto> {
    this.assertRateLimit(source);

    const key = (idempotencyKey ?? '').trim();
    if (!key || key.length > 128) {
      throw new BadRequestException({
        code: 'INGEST_IDEMPOTENCY_KEY_REQUIRED',
        message:
          'ต้องส่ง header X-Idempotency-Key (ไม่เกิน 128 ตัวอักษร) ทุกครั้ง',
      });
    }

    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      throw new BadRequestException({
        code: 'INGEST_PAYLOAD_INVALID',
        message: 'payload ต้องเป็น JSON object',
      });
    }
    const body = payload as Record<string, unknown>;

    const serialized = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(serialized, 'utf8');
    if (payloadBytes > source.maxPayloadBytes) {
      throw new PayloadTooLargeException({
        code: 'INGEST_PAYLOAD_TOO_LARGE',
        message: 'payload เกินขนาดสูงสุดที่แหล่งข้อมูลนี้กำหนด',
        maxPayloadBytes: source.maxPayloadBytes,
        payloadBytes,
      });
    }

    // Idempotent replay — duplicate (source_id, key) returns the
    // ORIGINAL row id with zero mutation (acceptance §6).
    const existing = await this.ingestionRepository.findOne({
      where: { sourceId: source.id, idempotencyKey: key },
    });
    if (existing) {
      await this.touchLastSeen(source.id);
      return this.toIngestResponse(existing, true);
    }

    const validationErrors = validateAgainstDeclaredSchema(
      body,
      source.payloadSchema,
    );
    const piiFlags = scanForPii(body);
    const contentHash = createHash('sha256')
      .update(serialized, 'utf8')
      .digest('hex');

    const row = this.ingestionRepository.create({
      sourceId: source.id,
      idempotencyKey: key,
      payload: body,
      payloadBytes,
      contentHash,
      receivedAt: new Date(),
      remoteIp,
      status:
        validationErrors.length > 0
          ? ('rejected' as const)
          : ('quarantined' as const),
      validationErrors:
        validationErrors.length > 0 ? { errors: validationErrors } : null,
      piiFlags: piiFlags.length > 0 ? { flags: piiFlags } : null,
      reviewedByWorkHistoryId: null,
      reviewedAt: null,
      promotedEntryId: null,
    });

    let saved: AiKnowledgeIngestion;
    try {
      saved = await this.ingestionRepository.save(row);
    } catch (err) {
      // UNIQUE (source_id, idempotency_key) race — a concurrent
      // duplicate won the insert; honor idempotency by returning it.
      if (this.isUniqueViolation(err)) {
        const winner = await this.ingestionRepository.findOne({
          where: { sourceId: source.id, idempotencyKey: key },
        });
        if (winner) {
          await this.touchLastSeen(source.id);
          return this.toIngestResponse(winner, true);
        }
      }
      throw err;
    }

    await this.touchLastSeen(source.id);
    return this.toIngestResponse(saved, false);
  }

  // ──────────────────────────────────────────────────────────────────
  // Quarantine review (ADMIN_OR_ABOVE via controller)
  // ──────────────────────────────────────────────────────────────────

  /** `GET /ingestions` — paginated review list. ZERO-WRITE (§18.13). */
  async listIngestions(
    query: ListKnowledgeIngestionsQueryDto,
  ): Promise<KnowledgeIngestionListResponseDto> {
    const page = query.page ?? 1;
    const limit = Math.min(
      query.limit ?? INGESTION_LIST_DEFAULT_LIMIT,
      INGESTION_LIST_MAX_LIMIT,
    );

    const qb = this.ingestionRepository
      .createQueryBuilder('ingestion')
      .where('ingestion.deletedAt IS NULL');

    if (query.sourceId) {
      qb.andWhere('ingestion.sourceId = :sourceId', {
        sourceId: query.sourceId,
      });
    }
    if (query.status) {
      qb.andWhere('ingestion.status = :status', { status: query.status });
    }

    const [rows, total] = await qb
      .orderBy('ingestion.receivedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      items: rows.map((r) => this.toIngestionDto(r)),
      total,
      page,
      limit,
    };
  }

  /**
   * `POST /ingestions/:id/promote` — quarantined → promoted.
   *
   * The SOLE bridge from staging into curated entries (§17.15.5).
   * Effective mapped fields = admin overrides ?? payload defaults
   * (`title` / `body_md` / `tags`) ?? source `target_domain_key`. The
   * effective title/body/tags are RE-SCANNED for PII — any hit blocks
   * with 422 INGEST_PII_BLOCKED until removed/masked (Q4). On success
   * the BE-02 service spawns a DRAFT entry (`origin='external'`,
   * `source_id` set) inside the same transaction as the verdict +
   * audit row — never auto-published.
   */
  async promote(
    id: string,
    dto: PromoteKnowledgeIngestionDto,
    userId: string,
  ): Promise<{ ingestion: KnowledgeIngestionDto; entry: KnowledgeEntryDto }> {
    const actor = await this.resolveActor(userId);
    const ingestion = await this.loadIngestionOrThrow(id);

    if (ingestion.status !== 'quarantined') {
      throw this.ingestionStatusInvalid(ingestion.status, 'promote');
    }

    const source = await this.sourceRepository.findOne({
      where: { id: ingestion.sourceId },
      withDeleted: true,
    });
    if (!source) {
      // Hard-deleted source would have cascaded its staging rows; a
      // missing row here is a true integrity surprise.
      throw new NotFoundException({
        code: 'SOURCE_NOT_FOUND',
        message: 'ไม่พบแหล่งข้อมูลต้นทางของรายการนี้',
      });
    }

    const payload = ingestion.payload ?? {};
    const title = dto.title ?? this.readString(payload, ['title']);
    const bodyMd =
      dto.bodyMd ?? this.readString(payload, ['body_md', 'bodyMd', 'body']);
    const tags = dto.tags ?? this.readStringArray(payload, ['tags']);
    const domainKey = dto.domainKey ?? source.targetDomainKey;

    if (!title?.trim() || !bodyMd?.trim()) {
      throw new BadRequestException({
        code: 'INGEST_PROMOTE_FIELDS_REQUIRED',
        message:
          'ไม่สามารถระบุ title/body จาก payload ได้ กรุณาระบุ override ในคำขอ',
      });
    }

    // Q4 — re-scan the EFFECTIVE mapped fields. Flags on parts of the
    // payload that do NOT map into the entry are thereby "resolved" by
    // omission; flags that survive into title/body/tags block.
    const effectiveFlags: PiiFlag[] = [
      ...scanForPii(title, '$.title'),
      ...scanForPii(bodyMd, '$.bodyMd'),
      ...scanForPii(tags, '$.tags'),
    ];
    if (effectiveFlags.length > 0) {
      throw new UnprocessableEntityException({
        code: 'INGEST_PII_BLOCKED',
        message:
          'พบรูปแบบข้อมูลส่วนบุคคล (เลขบัตรประชาชน/โทรศัพท์/อีเมล) ในเนื้อหา กรุณาลบหรือปิดบังก่อนนำเข้า',
        flags: effectiveFlags,
      });
    }

    const reviewedAt = new Date();
    return this.ingestionRepository.manager.transaction(async (manager) => {
      // 1. Spawn the DRAFT external entry via the BE-02 service (single
      //    writer of entries + revisions + entry audit).
      const entry = await this.knowledgeHubService.createExternalEntry(
        {
          domainKey,
          title,
          bodyMd,
          tags,
          classification: source.classificationCeiling,
          sourceId: source.deletedAt ? null : source.id,
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
        },
        manager,
      );

      // 2. Record the verdict on the staging row.
      await manager.getRepository(AiKnowledgeIngestion).update(
        { id },
        {
          status: 'promoted',
          promotedEntryId: entry.id,
          reviewedByWorkHistoryId: actor.workHistoryId,
          reviewedAt,
        },
      );

      // 3. Audit `promote` (§17.3 — never TrackingStatus).
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'promote',
          targetKind: 'ingestion',
          targetId: id,
          detail: { promotedEntryId: entry.id, domainKey },
        },
        manager,
      );

      return {
        ingestion: this.toIngestionDto({
          ...ingestion,
          status: 'promoted',
          promotedEntryId: entry.id,
          reviewedByWorkHistoryId: actor.workHistoryId,
          reviewedAt,
        }),
        entry,
      };
    });
  }

  /** `POST /ingestions/:id/reject` — quarantined → rejected + audit. */
  async reject(
    id: string,
    dto: RejectKnowledgeIngestionDto,
    userId: string,
  ): Promise<KnowledgeIngestionDto> {
    const actor = await this.resolveActor(userId);
    const ingestion = await this.loadIngestionOrThrow(id);

    if (ingestion.status !== 'quarantined') {
      throw this.ingestionStatusInvalid(ingestion.status, 'reject');
    }

    const reviewedAt = new Date();
    await this.ingestionRepository.manager.transaction(async (manager) => {
      await manager.getRepository(AiKnowledgeIngestion).update(
        { id },
        {
          status: 'rejected',
          reviewedByWorkHistoryId: actor.workHistoryId,
          reviewedAt,
        },
      );
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'reject',
          targetKind: 'ingestion',
          targetId: id,
          detail: { reason: dto.reason ?? null },
        },
        manager,
      );
    });

    return this.toIngestionDto({
      ...ingestion,
      status: 'rejected',
      reviewedByWorkHistoryId: actor.workHistoryId,
      reviewedAt,
    });
  }

  // ── private helpers ─────────────────────────────────────────────

  /**
   * Per-source fixed 60-second window. Exceeding `rate_limit_per_min`
   * answers 429 `{ code: 'INGEST_RATE_LIMITED', retryAfterSeconds }` —
   * envelope mirrors the §17.8 shape (per §17.15.5 this is a
   * per-source ingest limit, NOT a registered §17.8 AI cooldown key).
   */
  private assertRateLimit(source: AiKnowledgeSource): void {
    const now = Date.now();
    const window = this.rateWindows.get(source.id);

    if (
      !window ||
      now - window.windowStartMs >= KnowledgeIngestionService.RATE_WINDOW_MS
    ) {
      this.pruneRateStore(now);
      this.rateWindows.set(source.id, { windowStartMs: now, count: 1 });
      return;
    }

    if (window.count >= source.rateLimitPerMin) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (window.windowStartMs +
            KnowledgeIngestionService.RATE_WINDOW_MS -
            now) /
            1000,
        ),
      );
      throw new HttpException(
        { code: 'INGEST_RATE_LIMITED', retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    window.count += 1;
  }

  /** Bound the in-memory store — evict expired windows past the cap. */
  private pruneRateStore(now: number): void {
    if (this.rateWindows.size < KnowledgeIngestionService.RATE_STORE_CAP) {
      return;
    }
    for (const [key, window] of this.rateWindows) {
      if (
        now - window.windowStartMs >=
        KnowledgeIngestionService.RATE_WINDOW_MS
      ) {
        this.rateWindows.delete(key);
      }
    }
  }

  /** Source health touch — `last_seen_at` per report §4 monitoring. */
  private async touchLastSeen(sourceId: string): Promise<void> {
    await this.sourceRepository.update(
      { id: sourceId },
      { lastSeenAt: new Date() },
    );
  }

  private isUniqueViolation(err: unknown): boolean {
    const driverError = (err as { driverError?: { code?: string } })
      ?.driverError;
    return driverError?.code === '23505';
  }

  private readString(
    payload: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return undefined;
  }

  private readStringArray(
    payload: Record<string, unknown>,
    keys: string[],
  ): string[] {
    for (const key of keys) {
      const value = payload[key];
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
      ) {
        return value as string[];
      }
    }
    return [];
  }

  private async loadIngestionOrThrow(
    id: string,
  ): Promise<AiKnowledgeIngestion> {
    const ingestion = await this.ingestionRepository.findOne({
      where: { id },
    });
    if (!ingestion) {
      throw new NotFoundException({
        code: 'INGESTION_NOT_FOUND',
        message: 'ไม่พบรายการนำเข้าที่ระบุ',
      });
    }
    return ingestion;
  }

  private ingestionStatusInvalid(
    currentStatus: string,
    operation: string,
  ): ConflictException {
    return new ConflictException({
      code: 'INGEST_STATUS_INVALID',
      message: 'สถานะรายการนำเข้าปัจจุบันไม่อนุญาตให้ทำรายการนี้',
      currentStatus,
      operation,
    });
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

  private toIngestResponse(
    row: AiKnowledgeIngestion,
    duplicate: boolean,
  ): IngestResponseDto {
    const flags = (row.piiFlags as { flags?: PiiFlag[] } | null)?.flags ?? [];
    return {
      id: row.id,
      status: row.status,
      duplicate,
      contentHash: row.contentHash,
      piiFlagCount: flags.length,
      receivedAt: this.toIso(row.receivedAt),
    };
  }

  private toIngestionDto(row: AiKnowledgeIngestion): KnowledgeIngestionDto {
    return {
      id: row.id,
      sourceId: row.sourceId,
      idempotencyKey: row.idempotencyKey,
      payload: row.payload,
      payloadBytes: row.payloadBytes,
      contentHash: row.contentHash,
      receivedAt: this.toIso(row.receivedAt),
      status: row.status,
      validationErrors: row.validationErrors,
      piiFlags: (row.piiFlags as { flags: PiiFlag[] } | null) ?? null,
      reviewedByWorkHistoryId: row.reviewedByWorkHistoryId ?? null,
      reviewedAt: row.reviewedAt ? this.toIso(row.reviewedAt) : null,
      promotedEntryId: row.promotedEntryId ?? null,
      createdAt: this.toIso(row.createdAt),
    };
  }

  private toIso(value: Date | string | null | undefined): string {
    if (!value) return '';
    return value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();
  }
}
