import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import {
  isAllowedColorToken,
  isAllowedIconKey,
} from '../constants/structure-tokens';
import {
  PatchKnowledgeDomainDto,
  ReorderKnowledgeDomainsDto,
} from '../dto/structure-domain.dto';
import {
  CreateKnowledgeGapDto,
  PatchKnowledgeGapDto,
} from '../dto/structure-gap.dto';
import { AiKnowledgeDomainMeta } from '../entities/ai-knowledge-domain-meta.entity';
import {
  ALL_KNOWLEDGE_DOMAIN_KEYS,
  COVERAGE_GAPS,
} from '../registry/derived-domain-map';
import { KnowledgeAuditService } from './knowledge-audit.service';

/** Resolved acting admin — WorkHistory uuid + role name at action time. */
interface KnowledgeStructureActor {
  workHistoryId: string;
  roleName: string;
}

/** Response shape for a single domain-overlay PATCH. */
export interface KnowledgeDomainOverlayDto {
  id: string;
  domainKey: string;
  labelThOverride: string | null;
  labelEnOverride: string | null;
  descriptionTh: string | null;
  displayOrder: number;
  colorToken: string | null;
  iconKey: string | null;
  isHidden: boolean;
}

/** Response shape for a coverage-gap create / patch. */
export interface KnowledgeGapDto {
  id: string;
  key: string;
  labelTh: string | null;
  gapReasonTh: string | null;
  displayOrder: number;
  isHidden: boolean;
}

/** Response shape for the bulk-reorder convenience endpoint. */
export interface KnowledgeReorderResultDto {
  /** The keys whose `display_order` was actually stamped, in applied order. */
  appliedOrder: string[];
  /** Keys from the request that were ignored (no overlay row to reorder). */
  ignoredKeys: string[];
}

/**
 * Response shape for a gap DELETE. `softDeleted = true` means a UI-created
 * gap row was soft-deleted; `hidden = true` means a CODE gap (e.g.
 * `equipment`) was hidden instead (it re-appears from code, so it cannot
 * be hard-removed — task §3).
 */
export interface KnowledgeGapDeleteResultDto {
  key: string;
  softDeleted: boolean;
  hidden: boolean;
  /** Thai nuance note surfaced to the FE (task §3). */
  note: string;
}

const CODE_GAP_KEYS: ReadonlySet<string> = new Set(
  COVERAGE_GAPS.map((gap) => gap.key),
);

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-02 (2026-06-13).
 *
 * KnowledgeStructureService — Phase-1 Class-A MUTATIONS for the executive
 * mind-map structure: domain DISPLAY overlay PATCH (topic i) + coverage-
 * gap CRUD (topic ii). All operations write to `ai_knowledge_domain_meta`
 * ONLY (overlay-not-replacement — the code registry stays the source of
 * truth for WHICH domains exist + their tool bindings).
 *
 * CLAUDE.md references:
 *   - §17.2 — every field here is advisory DISPLAY metadata; nothing
 *     gates any workflow transition, ownership, or permission.
 *   - §17.3 — mutations audit via `ai_knowledge_audit_logs`
 *     (`domain_meta_update` / `gap_create` / `gap_update` / `gap_delete`)
 *     and NEVER TrackingStatus. Actors are referenced by WorkHistory uuid
 *     WITHOUT referential integrity. NO FK into any project table.
 *   - §17.11 — no role exemption: the Q-05 "derived domains are display-
 *     only, never add/delete" rule is an INTEGRITY guarantee re-asserted
 *     here at the service layer (the DTO already omits key/layer/tools);
 *     no role, super-admin included, may bypass it.
 *   - §17.16 (DOCS-01) — Class A scope, overlay-not-replacement, no-DDL
 *     (this service touches no real schema — `domainKey` is plain text).
 *
 * Transaction + audit contract (task §6): every mutation runs inside a
 * single transaction and writes EXACTLY ONE audit row through the shared
 * `KnowledgeAuditService` using the caller's transactional `manager`, so
 * the audit row commits/rolls back atomically with the overlay write.
 *
 * Concurrency (task §8): Class-A display data is last-write-wins — no
 * optimistic-version column (unlike curated entries). Each write is
 * audited, so history is recoverable.
 *
 * BE-03 (catalog CRUD) and BE-04 (tool binding) extend the SAME
 * `KnowledgeStructureController`; they will add their own service methods
 * (or a sibling service) — this Phase-1 service stays domain/gap-scoped.
 */
@Injectable()
export class KnowledgeStructureService {
  constructor(
    @InjectRepository(AiKnowledgeDomainMeta)
    private readonly domainMetaRepository: Repository<AiKnowledgeDomainMeta>,
    /**
     * Actor resolution per §4 / §17.3 — every mutation records the acting
     * admin's CURRENT WorkHistory uuid + denormalized role name. Read-only
     * here; no hub-entity relation is introduced (§17.3 stays intact).
     */
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    /** The single `ai_knowledge_audit_logs` writer (§17.3). */
    private readonly knowledgeAuditService: KnowledgeAuditService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Topic (i) — domain display-overlay PATCH
  // ──────────────────────────────────────────────────────────────────

  /**
   * `PATCH /structure/domains/:domainKey` — upsert the display overlay for
   * a code-declared domain (admin + super-admin, Q-03).
   *
   * Guards (in order):
   *   1. `domainKey ∈ ALL_KNOWLEDGE_DOMAIN_KEYS` → else
   *      `400 KNOWLEDGE_DOMAIN_UNKNOWN` (Q-05 — only existing code domains
   *      are reorder/relabel-able; this also blocks "add a derived domain
   *      via UI").
   *   2. `colorToken` / `iconKey` ∈ allow-list → else
   *      `400 KNOWLEDGE_TOKEN_INVALID`.
   *
   * Then, in ONE transaction: upsert the `node_kind = 'domain'` overlay row
   * (INSERT when absent, UPDATE only the provided fields when present —
   * merge-patch; `null` explicitly clears an override back to the code
   * value) and write one `domain_meta_update` audit row with a diff
   * summary in `detail`.
   */
  async patchDomainOverlay(
    domainKey: string,
    dto: PatchKnowledgeDomainDto,
    userId: string,
  ): Promise<KnowledgeDomainOverlayDto> {
    const actor = await this.resolveActor(userId);
    this.assertKnownDomainKey(domainKey);
    this.assertTokensAllowed(dto.colorToken, dto.iconKey);

    return this.domainMetaRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AiKnowledgeDomainMeta);
      const existing = await repo.findOne({
        where: { domainKey },
        withDeleted: true,
      });

      const changedFields = this.collectChangedDomainFields(dto, existing);

      let saved: AiKnowledgeDomainMeta;
      if (existing) {
        this.applyDomainPatch(existing, dto);
        existing.updatedByWorkHistoryId = actor.workHistoryId;
        // A previously soft-deleted domain overlay is impossible in
        // practice (domains are never deleted, Q-05), but if a stray row
        // exists, editing it un-tombstones the DISPLAY overlay.
        existing.deletedAt = null;
        saved = await repo.save(existing);
      } else {
        saved = await repo.save(
          repo.create({
            domainKey,
            nodeKind: 'domain' as const,
            labelThOverride: dto.labelThOverride ?? null,
            labelEnOverride: dto.labelEnOverride ?? null,
            descriptionTh: dto.descriptionTh ?? null,
            displayOrder: dto.displayOrder ?? 0,
            colorToken: dto.colorToken ?? null,
            iconKey: dto.iconKey ?? null,
            isHidden: dto.isHidden ?? false,
            gapReasonTh: null,
            createdByWorkHistoryId: actor.workHistoryId,
            updatedByWorkHistoryId: actor.workHistoryId,
          }),
        );
      }

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'domain_meta_update',
          targetKind: 'domain_meta',
          targetId: saved.id,
          detail: {
            domainKey,
            created: !existing,
            changedFields,
          },
        },
        manager,
      );

      return this.toDomainOverlayDto(saved);
    });
  }

  /**
   * `PATCH /structure/domains/order` — bulk drag-reorder (task §3). Stamps
   * each key's `display_order` to its array index in one transaction.
   *
   * Stale-key tolerance (task §8): a key with NO overlay row is IGNORED
   * (not rejected) — only existing overlay rows are reordered; the
   * response echoes the applied order + the ignored keys. ONE batch
   * `domain_meta_update` audit row carries the full applied order in
   * `detail` (task §3 batch-row choice — keeps audit volume sane).
   */
  async reorderDomains(
    dto: ReorderKnowledgeDomainsDto,
    userId: string,
  ): Promise<KnowledgeReorderResultDto> {
    const actor = await this.resolveActor(userId);

    // De-dup while preserving first-seen order — a duplicated key in the
    // request maps to its first index only.
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    for (const key of dto.domainKeys) {
      if (!seen.has(key)) {
        seen.add(key);
        orderedKeys.push(key);
      }
    }

    return this.domainMetaRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AiKnowledgeDomainMeta);
      const rows = await repo.find({
        where: { domainKey: In(orderedKeys) },
      });
      const rowByKey = new Map(rows.map((row) => [row.domainKey, row]));

      const appliedOrder: string[] = [];
      const ignoredKeys: string[] = [];

      orderedKeys.forEach((key, index) => {
        const row = rowByKey.get(key);
        if (!row) {
          ignoredKeys.push(key);
          return;
        }
        row.displayOrder = index;
        row.updatedByWorkHistoryId = actor.workHistoryId;
        appliedOrder.push(key);
      });

      const touched = appliedOrder
        .map((key) => rowByKey.get(key))
        .filter((row): row is AiKnowledgeDomainMeta => row !== undefined);
      if (touched.length > 0) {
        await repo.save(touched);
      }

      // ONE batch audit row (task §3 — batch-row choice).
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'domain_meta_update',
          targetKind: 'domain_meta',
          // No single target — use the nil-uuid sentinel (the batch row's
          // payload IS the order). Mirrors the system-actor sentinel
          // convention used by the seed service.
          targetId: '00000000-0000-0000-0000-000000000000',
          detail: { batchReorder: true, appliedOrder, ignoredKeys },
        },
        manager,
      );

      return { appliedOrder, ignoredKeys };
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Topic (ii) — coverage-gap CRUD
  // ──────────────────────────────────────────────────────────────────

  /**
   * `POST /structure/gaps` — create a UI coverage-gap node (admin + super-
   * admin, Q-03).
   *
   * Collision guard (task §3): the new `domainKey` MUST NOT collide with a
   * code domain key, a code gap key, OR an existing (incl. soft-deleted)
   * overlay row → else `400 KNOWLEDGE_GAP_KEY_COLLISION`. The label is
   * stored in `label_th_override`, the reason in `gap_reason_th`. Audits
   * `gap_create`.
   */
  async createGap(
    dto: CreateKnowledgeGapDto,
    userId: string,
  ): Promise<KnowledgeGapDto> {
    const actor = await this.resolveActor(userId);
    await this.assertGapKeyAvailable(dto.domainKey);

    return this.domainMetaRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AiKnowledgeDomainMeta);
      const saved = await repo.save(
        repo.create({
          domainKey: dto.domainKey,
          nodeKind: 'gap' as const,
          labelThOverride: dto.labelTh,
          labelEnOverride: null,
          descriptionTh: null,
          displayOrder: dto.displayOrder ?? 0,
          colorToken: null,
          iconKey: null,
          isHidden: false,
          gapReasonTh: dto.gapReasonTh ?? null,
          createdByWorkHistoryId: actor.workHistoryId,
          updatedByWorkHistoryId: actor.workHistoryId,
        }),
      );

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'gap_create',
          targetKind: 'gap',
          targetId: saved.id,
          detail: { key: saved.domainKey },
        },
        manager,
      );

      return this.toGapDto(saved);
    });
  }

  /**
   * `PATCH /structure/gaps/:domainKey` — edit a coverage gap (admin +
   * super-admin, Q-03).
   *
   * Upsert-on-code-gap: a CODE gap (e.g. `equipment`) may have no overlay
   * row yet — editing it INSERTS the overlay (so the code gap is now
   * re-skinnable), mirroring the domain-overlay upsert. A non-existent
   * NON-code key → `404 KNOWLEDGE_GAP_NOT_FOUND`. Audits `gap_update`.
   */
  async patchGap(
    domainKey: string,
    dto: PatchKnowledgeGapDto,
    userId: string,
  ): Promise<KnowledgeGapDto> {
    const actor = await this.resolveActor(userId);

    return this.domainMetaRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AiKnowledgeDomainMeta);
      const existing = await repo.findOne({
        where: { domainKey, nodeKind: 'gap' },
      });

      if (!existing && !CODE_GAP_KEYS.has(domainKey)) {
        throw this.gapNotFound(domainKey);
      }

      const changedFields = this.collectChangedGapFields(dto, existing);

      let saved: AiKnowledgeDomainMeta;
      if (existing) {
        if (dto.labelTh !== undefined) existing.labelThOverride = dto.labelTh;
        if (dto.gapReasonTh !== undefined) {
          existing.gapReasonTh = dto.gapReasonTh;
        }
        if (dto.displayOrder !== undefined) {
          existing.displayOrder = dto.displayOrder;
        }
        if (dto.isHidden !== undefined) existing.isHidden = dto.isHidden;
        existing.updatedByWorkHistoryId = actor.workHistoryId;
        saved = await repo.save(existing);
      } else {
        // Code gap with no overlay yet — INSERT a re-skin row.
        const codeGap = COVERAGE_GAPS.find((gap) => gap.key === domainKey);
        saved = await repo.save(
          repo.create({
            domainKey,
            nodeKind: 'gap' as const,
            labelThOverride: dto.labelTh ?? codeGap?.labelTh ?? null,
            labelEnOverride: null,
            descriptionTh: null,
            displayOrder: dto.displayOrder ?? 0,
            colorToken: null,
            iconKey: null,
            isHidden: dto.isHidden ?? false,
            gapReasonTh: dto.gapReasonTh ?? codeGap?.reason ?? null,
            createdByWorkHistoryId: actor.workHistoryId,
            updatedByWorkHistoryId: actor.workHistoryId,
          }),
        );
      }

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'gap_update',
          targetKind: 'gap',
          targetId: saved.id,
          detail: { key: domainKey, created: !existing, changedFields },
        },
        manager,
      );

      return this.toGapDto(saved);
    });
  }

  /**
   * `DELETE /structure/gaps/:domainKey` — remove a coverage gap (admin +
   * super-admin, Q-03).
   *
   * Two outcomes (task §3):
   *   - UI-created gap (key NOT in code) → soft-delete the overlay row
   *     (audit row written BEFORE `deletedAt`, tombstone-before-delete).
   *   - CODE gap (e.g. `equipment`) → CANNOT be hard-removed (it re-appears
   *     from code). Instead set `is_hidden = true` on its overlay
   *     (upserting the overlay if absent). The response carries the
   *     `hidden` flag + a Thai nuance note.
   *
   * Audits `gap_delete` in both cases.
   */
  async deleteGap(
    domainKey: string,
    userId: string,
  ): Promise<KnowledgeGapDeleteResultDto> {
    const actor = await this.resolveActor(userId);
    const isCodeGap = CODE_GAP_KEYS.has(domainKey);

    return this.domainMetaRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AiKnowledgeDomainMeta);
      const existing = await repo.findOne({
        where: { domainKey, nodeKind: 'gap' },
      });

      if (!existing && !isCodeGap) {
        throw this.gapNotFound(domainKey);
      }

      if (isCodeGap) {
        // Code gap → hide, don't destroy (re-appears from code).
        let saved: AiKnowledgeDomainMeta;
        if (existing) {
          existing.isHidden = true;
          existing.updatedByWorkHistoryId = actor.workHistoryId;
          saved = await repo.save(existing);
        } else {
          const codeGap = COVERAGE_GAPS.find((gap) => gap.key === domainKey);
          saved = await repo.save(
            repo.create({
              domainKey,
              nodeKind: 'gap' as const,
              labelThOverride: codeGap?.labelTh ?? null,
              labelEnOverride: null,
              descriptionTh: null,
              displayOrder: 0,
              colorToken: null,
              iconKey: null,
              isHidden: true,
              gapReasonTh: codeGap?.reason ?? null,
              createdByWorkHistoryId: actor.workHistoryId,
              updatedByWorkHistoryId: actor.workHistoryId,
            }),
          );
        }

        await this.knowledgeAuditService.record(
          {
            actorWorkHistoryId: actor.workHistoryId,
            actorRole: actor.roleName,
            action: 'gap_delete',
            targetKind: 'gap',
            targetId: saved.id,
            detail: { key: domainKey, codeGap: true, hidden: true },
          },
          manager,
        );

        return {
          key: domainKey,
          softDeleted: false,
          hidden: true,
          note: 'ช่องว่างความรู้นี้มาจากระบบ (โค้ด) จึงลบถาวรไม่ได้ — ระบบได้ซ่อนออกจากแผนผังแทน',
        };
      }

      // UI-created gap → tombstone audit row BEFORE soft delete.
      // `existing` is guaranteed non-null here (the not-found guard above
      // covers the non-code missing case).
      const row = existing as AiKnowledgeDomainMeta;
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'gap_delete',
          targetKind: 'gap',
          targetId: row.id,
          detail: { key: domainKey, codeGap: false, hidden: false },
        },
        manager,
      );

      await repo.softDelete({ id: row.id });

      return {
        key: domainKey,
        softDeleted: true,
        hidden: false,
        note: 'ลบช่องว่างความรู้ที่สร้างผ่านหน้าจอแล้ว',
      };
    });
  }

  // ── private helpers ──────────────────────────────────────────────

  /**
   * Resolve the acting admin's CURRENT WorkHistory (§4 source of truth) —
   * uuid for the audit trail + role name denormalized at action time. The
   * guard chain (JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard) has
   * already admitted the caller; this is the §17.3 actor-identity read,
   * not a second permission gate.
   */
  private async resolveActor(
    userId: string,
  ): Promise<KnowledgeStructureActor> {
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    const workHistory = await this.workHistoryRepository.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role'],
    });
    if (!workHistory) {
      // Defensive — WorkStatusApprovedGuard already requires a current
      // WorkHistory; mirrors the guard's error contract on the race.
      throw new ForbiddenException('WORK_STATUS_NOT_APPROVED');
    }
    return {
      workHistoryId: workHistory.id,
      roleName: workHistory.role?.name ?? '',
    };
  }

  /** `domainKey` must be a code-declared domain (Q-05 — display-only edit). */
  private assertKnownDomainKey(domainKey: string): void {
    if (!ALL_KNOWLEDGE_DOMAIN_KEYS.includes(domainKey)) {
      throw new BadRequestException({
        code: 'KNOWLEDGE_DOMAIN_UNKNOWN',
        message: 'ไม่พบหมวดองค์ความรู้ที่ระบุ (domainKey ไม่ถูกต้อง)',
        domainKey,
      });
    }
  }

  /**
   * A non-null `colorToken` / `iconKey` MUST be in the closed allow-list
   * (`structure-tokens.ts`). `null` / `undefined` are fine (clear / leave).
   * Service-layer re-assertion of the DTO `@IsIn` (defense-in-depth) with
   * the structured `KNOWLEDGE_TOKEN_INVALID` code.
   */
  private assertTokensAllowed(
    colorToken: string | null | undefined,
    iconKey: string | null | undefined,
  ): void {
    if (
      colorToken !== null &&
      colorToken !== undefined &&
      !isAllowedColorToken(colorToken)
    ) {
      throw new BadRequestException({
        code: 'KNOWLEDGE_TOKEN_INVALID',
        message: 'รหัสสีไม่อยู่ในรายการที่อนุญาต',
        field: 'colorToken',
        value: colorToken,
      });
    }
    if (
      iconKey !== null &&
      iconKey !== undefined &&
      !isAllowedIconKey(iconKey)
    ) {
      throw new BadRequestException({
        code: 'KNOWLEDGE_TOKEN_INVALID',
        message: 'รหัสไอคอนไม่อยู่ในรายการที่อนุญาต',
        field: 'iconKey',
        value: iconKey,
      });
    }
  }

  /**
   * A new gap key must not collide with a code domain key, a code gap key,
   * or any existing overlay row (incl. soft-deleted — a re-used key would
   * resurrect a tombstoned node on the next seed). → `400
   * KNOWLEDGE_GAP_KEY_COLLISION`.
   */
  private async assertGapKeyAvailable(domainKey: string): Promise<void> {
    if (
      ALL_KNOWLEDGE_DOMAIN_KEYS.includes(domainKey) ||
      CODE_GAP_KEYS.has(domainKey)
    ) {
      throw this.gapKeyCollision(domainKey);
    }
    const existing = await this.domainMetaRepository.findOne({
      where: { domainKey },
      withDeleted: true,
    });
    if (existing) {
      throw this.gapKeyCollision(domainKey);
    }
  }

  /** Apply the merge-patch onto an existing domain overlay row in place. */
  private applyDomainPatch(
    row: AiKnowledgeDomainMeta,
    dto: PatchKnowledgeDomainDto,
  ): void {
    if (dto.labelThOverride !== undefined) {
      row.labelThOverride = dto.labelThOverride;
    }
    if (dto.labelEnOverride !== undefined) {
      row.labelEnOverride = dto.labelEnOverride;
    }
    if (dto.descriptionTh !== undefined) row.descriptionTh = dto.descriptionTh;
    if (dto.displayOrder !== undefined) row.displayOrder = dto.displayOrder;
    if (dto.colorToken !== undefined) row.colorToken = dto.colorToken;
    if (dto.iconKey !== undefined) row.iconKey = dto.iconKey;
    if (dto.isHidden !== undefined) row.isHidden = dto.isHidden;
  }

  /** Diff summary for the `domain_meta_update` audit `detail`. */
  private collectChangedDomainFields(
    dto: PatchKnowledgeDomainDto,
    existing: AiKnowledgeDomainMeta | null,
  ): string[] {
    const fields: string[] = [];
    const consider = (
      name: keyof PatchKnowledgeDomainDto,
      currentValue: unknown,
    ): void => {
      if (dto[name] === undefined) return;
      if (!existing || dto[name] !== currentValue) fields.push(name);
    };
    consider('labelThOverride', existing?.labelThOverride);
    consider('labelEnOverride', existing?.labelEnOverride);
    consider('descriptionTh', existing?.descriptionTh);
    consider('displayOrder', existing?.displayOrder);
    consider('colorToken', existing?.colorToken);
    consider('iconKey', existing?.iconKey);
    consider('isHidden', existing?.isHidden);
    return fields;
  }

  /** Diff summary for the `gap_update` audit `detail`. */
  private collectChangedGapFields(
    dto: PatchKnowledgeGapDto,
    existing: AiKnowledgeDomainMeta | null,
  ): string[] {
    const fields: string[] = [];
    if (dto.labelTh !== undefined) {
      if (!existing || dto.labelTh !== existing.labelThOverride) {
        fields.push('labelTh');
      }
    }
    if (dto.gapReasonTh !== undefined) {
      if (!existing || dto.gapReasonTh !== existing.gapReasonTh) {
        fields.push('gapReasonTh');
      }
    }
    if (dto.displayOrder !== undefined) {
      if (!existing || dto.displayOrder !== existing.displayOrder) {
        fields.push('displayOrder');
      }
    }
    if (dto.isHidden !== undefined) {
      if (!existing || dto.isHidden !== existing.isHidden) {
        fields.push('isHidden');
      }
    }
    return fields;
  }

  private gapKeyCollision(domainKey: string): BadRequestException {
    return new BadRequestException({
      code: 'KNOWLEDGE_GAP_KEY_COLLISION',
      message:
        'คีย์ช่องว่างความรู้นี้ซ้ำกับหมวด/ช่องว่างที่มีอยู่แล้ว กรุณาใช้คีย์อื่น',
      domainKey,
    });
  }

  private gapNotFound(domainKey: string): NotFoundException {
    return new NotFoundException({
      code: 'KNOWLEDGE_GAP_NOT_FOUND',
      message: 'ไม่พบช่องว่างความรู้ที่ระบุ',
      domainKey,
    });
  }

  private toDomainOverlayDto(
    row: AiKnowledgeDomainMeta,
  ): KnowledgeDomainOverlayDto {
    return {
      id: row.id,
      domainKey: row.domainKey,
      labelThOverride: row.labelThOverride ?? null,
      labelEnOverride: row.labelEnOverride ?? null,
      descriptionTh: row.descriptionTh ?? null,
      displayOrder: row.displayOrder,
      colorToken: row.colorToken ?? null,
      iconKey: row.iconKey ?? null,
      isHidden: row.isHidden,
    };
  }

  private toGapDto(row: AiKnowledgeDomainMeta): KnowledgeGapDto {
    return {
      id: row.id,
      key: row.domainKey,
      labelTh: row.labelThOverride ?? null,
      gapReasonTh: row.gapReasonTh ?? null,
      displayOrder: row.displayOrder,
      isHidden: row.isHidden,
    };
  }
}
