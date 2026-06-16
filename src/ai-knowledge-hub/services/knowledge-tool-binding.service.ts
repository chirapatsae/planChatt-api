import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import {
  EXECUTIVE_TOOL_NAMES,
  EXECUTIVE_TOOL_REGISTRY,
} from 'src/ai-executive-chat/tools/tool-registry';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { PutToolBindingDto } from '../dto/tool-binding.dto';
import { KnowledgeMapToolDto } from '../dto/knowledge-map.dto';
import { AiKnowledgeToolBinding } from '../entities/ai-knowledge-tool-binding.entity';
import {
  DERIVED_DOMAIN_KEYS,
  KNOWLEDGE_DOMAINS,
} from '../registry/derived-domain-map';
import { KnowledgeAuditService } from './knowledge-audit.service';

/** Resolved acting super-admin — WorkHistory uuid + role name at action time. */
interface KnowledgeToolBindingActor {
  workHistoryId: string;
  roleName: string;
}

/** A single domain's resolved tool binding (override OR code fallback). */
export interface ToolBindingDomainDto {
  domainKey: string;
  /** Resolved backing tools (override set when present, else code). */
  tools: KnowledgeMapToolDto[];
}

/**
 * `GET /structure/tool-bindings` read envelope — the resolved binding per
 * derived domain + the full read-only registry + the orphan / double-map
 * diagnostics the Phase-3 editor surfaces to super-admin.
 */
export interface ToolBindingReadDto {
  /**
   * `'override'` when the `ai_knowledge_tool_binding` table has ANY row
   * (the override set is the live source of truth); `'code'` when empty
   * (the resolver falls back to `KNOWLEDGE_DOMAINS[].toolNames` — the
   * pre-Phase-3 behaviour, zero change).
   */
  source: 'code' | 'override';
  /** Resolved binding per derived domain (curated domains carry no tools). */
  domains: ToolBindingDomainDto[];
  /** The full read-only pick-list (every `EXECUTIVE_TOOL_NAMES` entry). */
  toolRegistry: KnowledgeMapToolDto[];
  /**
   * Registry tools NOT present in any domain's RESOLVED binding — the
   * orphan detector. Empty when the bijection holds.
   */
  unmappedTools: KnowledgeMapToolDto[];
  /**
   * Tools resolved to MORE than one domain — a double-map. Always empty
   * for an override set (the runtime guard + `UNIQUE(tool_name)` forbid
   * persisting one) and for the code map (the compile-time spec forbids
   * it); surfaced so an out-of-band DB edit is visible.
   */
  doubleMappedTools: KnowledgeMapToolDto[];
}

/** Write-result envelope for a `PUT /structure/tool-bindings/:domainKey`. */
export interface ToolBindingWriteResultDto {
  domainKey: string;
  /** The applied tool set for this domain, post-commit. */
  tools: KnowledgeMapToolDto[];
  /** Resolved binding across ALL derived domains after the change. */
  source: 'override';
  domains: ToolBindingDomainDto[];
}

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-04 (Phase 3, 2026-06-13).
 *
 * KnowledgeToolBindingService — the Class-B tool↔domain binding OVERRIDE
 * editor (topic v — report §3.6 / §6.2). This is the ONE piece of
 * "behind-the-scenes" knowledge data that corrupts AI retrieval routing
 * if mis-set, so it is guard-railed harder than every Class-A surface:
 * SUPER-ADMIN ONLY (Q-04) + a RUNTIME registry⇄domain BIJECTION guard on
 * every save (the same guarantee the compile-time
 * `derived-domain-map.spec.ts` enforces over the CODE map; this service
 * enforces it over the OVERRIDE).
 *
 * Bijection strategy B2-with-B1-default (CTO decision #5 / report §6.2):
 *
 *   - EMPTY `ai_knowledge_tool_binding` → the resolver falls back to
 *     `KNOWLEDGE_DOMAINS[].toolNames` from code (B1). Phase 1–2 never
 *     write a row, so `resolveDomainToolBinding` is byte-identical to the
 *     pre-Phase-3 code map (fallback proof, task §6).
 *   - ANY row → the override set is the live source of truth (B2). Every
 *     `PUT` re-asserts the full bijection BEFORE commit:
 *       1. every `toolName ∈ EXECUTIVE_TOOL_NAMES`
 *       2. no `toolName` already bound to a DIFFERENT domain (no
 *          double-map — service check AND the DB `UNIQUE(tool_name)`)
 *       3. after applying the change, EVERY registry tool maps to EXACTLY
 *          one domain (no orphan)
 *     A violation → `400 KNOWLEDGE_TOOL_BINDING_INVALID` and the whole
 *     transaction rolls back (no partial binding state, task §8).
 *
 * CLAUDE.md references:
 *   - §17.2 — tool binding is advisory ROUTING metadata; it gates no
 *     workflow transition. (It DOES steer which live tool backs a
 *     domain at chat-turn start — but that is retrieval routing, not a
 *     workflow gate.)
 *   - §17.3 — mutations audit via `ai_knowledge_audit_logs`
 *     (`tool_binding_update`) and NEVER TrackingStatus. The actor is a
 *     plain WorkHistory uuid; the table has NO FK into any project table
 *     (`domain_key` / `tool_name` are plain text).
 *   - §17.11 / §17.14.5 — NO role exemption: there is NO super-admin
 *     bypass branch. The bijection guard is the ONLY gate, and it is
 *     integrity, not permission — super-admin cannot persist a violating
 *     binding.
 *   - §17.16.5 (DOCS-01) — runtime bijection guard; §17.16.6 — empty
 *     override → code fallback; §17.16.7 — super-admin only (Q-04);
 *     §17.16.8 — no role exemption.
 *
 * Transaction + audit contract (task §6): the entire guard runs inside a
 * single transaction; the override write + the single
 * `tool_binding_update` audit row commit / roll back atomically with it.
 */
@Injectable()
export class KnowledgeToolBindingService {
  /** Registry tool name → display metadata, for the read projection. */
  private readonly toolMetaByName = new Map<string, KnowledgeMapToolDto>(
    EXECUTIVE_TOOL_NAMES.map((name) => {
      const spec = EXECUTIVE_TOOL_REGISTRY[name];
      return [
        name,
        { name: spec.name, thaiLabel: spec.thaiLabel, description: spec.description },
      ] as const;
    }),
  );

  constructor(
    @InjectRepository(AiKnowledgeToolBinding)
    private readonly toolBindingRepository: Repository<AiKnowledgeToolBinding>,
    /**
     * Actor resolution per §4 / §17.3 — every mutation records the acting
     * super-admin's CURRENT WorkHistory uuid + denormalized role name.
     * Read-only here; no hub-entity relation is introduced (§17.3 intact).
     */
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    /** The single `ai_knowledge_audit_logs` writer (§17.3). */
    private readonly knowledgeAuditService: KnowledgeAuditService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Resolver (B1 default / B2 override) — the single binding source
  // ──────────────────────────────────────────────────────────────────

  /**
   * Resolve the FULL tool→domain binding map. Empty override table → the
   * code map (`KNOWLEDGE_DOMAINS[].toolNames`, B1 fallback); any override
   * row → the persisted set grouped by `domain_key` (B2). Accepts an
   * optional `EntityManager` so the guard can read the in-transaction
   * state. ZERO-WRITE.
   *
   * This is THE seam BE-01's `unmappedTools[]` consults in Phase 3 (task
   * §3) — and the seam the executive-chat turn-start binding reads.
   */
  async resolveBindingMap(
    manager?: EntityManager,
  ): Promise<{ source: 'code' | 'override'; byDomain: Map<string, string[]> }> {
    const repo = manager
      ? manager.getRepository(AiKnowledgeToolBinding)
      : this.toolBindingRepository;
    const rows = await repo.find();

    if (rows.length === 0) {
      // B1 — code is the source of truth (pre-Phase-3 behaviour).
      const byDomain = new Map<string, string[]>();
      for (const domain of KNOWLEDGE_DOMAINS) {
        byDomain.set(domain.key, [...domain.toolNames]);
      }
      return { source: 'code', byDomain };
    }

    // B2 — override set is the live source of truth. Seed every derived
    // domain key so a domain with zero override rows shows as empty (not
    // absent) in the projection.
    const byDomain = new Map<string, string[]>(
      DERIVED_DOMAIN_KEYS.map((key) => [key, []] as [string, string[]]),
    );
    for (const row of rows) {
      const list = byDomain.get(row.domainKey) ?? [];
      list.push(row.toolName);
      byDomain.set(row.domainKey, list);
    }
    return { source: 'override', byDomain };
  }

  /**
   * Resolve a single domain's backing tool names (override OR code). Used
   * by retrieval routing at chat-turn start. ZERO-WRITE.
   */
  async resolveDomainToolBinding(domainKey: string): Promise<string[]> {
    const { byDomain } = await this.resolveBindingMap();
    return byDomain.get(domainKey) ?? [];
  }

  // ──────────────────────────────────────────────────────────────────
  // GET /structure/tool-bindings — read + diagnostics
  // ──────────────────────────────────────────────────────────────────

  /**
   * `GET /structure/tool-bindings` — the resolved binding per derived
   * domain + the full registry pick-list + `unmappedTools[]` /
   * `doubleMappedTools[]` diagnostics (admin + super-admin read, task §3).
   * ZERO-WRITE.
   */
  async getToolBindings(): Promise<ToolBindingReadDto> {
    const { source, byDomain } = await this.resolveBindingMap();

    const domains: ToolBindingDomainDto[] = DERIVED_DOMAIN_KEYS.map(
      (domainKey) => ({
        domainKey,
        tools: this.toDtos(byDomain.get(domainKey) ?? []),
      }),
    );

    const occurrences = this.countOccurrences(byDomain);
    const unmappedTools = this.toDtos(
      EXECUTIVE_TOOL_NAMES.filter((name) => (occurrences.get(name) ?? 0) === 0),
    );
    const doubleMappedTools = this.toDtos(
      [...occurrences.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    );

    return {
      source,
      domains,
      toolRegistry: this.toDtos([...EXECUTIVE_TOOL_NAMES]),
      unmappedTools,
      doubleMappedTools,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // PUT /structure/tool-bindings/:domainKey — guard-railed override
  // ──────────────────────────────────────────────────────────────────

  /**
   * `PUT /structure/tool-bindings/:domainKey` — replace the override tool
   * set for one derived domain (SUPER-ADMIN ONLY, Q-04). The full runtime
   * bijection guard runs inside the transaction BEFORE the override write;
   * any violation rolls the whole thing back (task §8 — never a partial
   * binding). Audits exactly one `tool_binding_update` row with the
   * before/after sets in `detail`.
   */
  async putToolBinding(
    domainKey: string,
    dto: PutToolBindingDto,
    userId: string,
  ): Promise<ToolBindingWriteResultDto> {
    const actor = await this.resolveActor(userId);
    this.assertDerivedDomainKey(domainKey);

    // De-dup the incoming set while preserving order (a domain binding
    // the same tool twice in one body is a no-op duplicate, not a
    // double-map across domains).
    const desired = this.dedupePreserveOrder(dto.toolNames);

    return this.toolBindingRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AiKnowledgeToolBinding);

      // Snapshot the FULL override-or-code binding as the bijection base,
      // then overlay this domain's desired set on top. (When the table is
      // empty we promote the code map into an override — the first write
      // flips B1 → B2; the guard then proves the promoted map is exact.)
      const { byDomain } = await this.resolveBindingMap(manager);
      const before = [...(byDomain.get(domainKey) ?? [])];
      const projected = new Map(
        [...byDomain.entries()].map(([key, list]) => [key, [...list]]),
      );
      projected.set(domainKey, desired);

      // RUNTIME BIJECTION GUARD — §17.16.5. Any failure throws BEFORE the
      // write, so the transaction rolls back. NO super-admin bypass.
      this.assertBijection(projected);

      // Apply: delete this domain's existing override rows, insert the new
      // set. (The other domains' rows are untouched — their slice of the
      // bijection is unchanged.) On the first-ever write we must also
      // persist EVERY other domain's code binding so the table reflects
      // the full B2 set (otherwise the next read would see a partial
      // override that orphans the unwritten domains' tools).
      const tableWasEmpty = (await repo.count()) === 0;
      if (tableWasEmpty) {
        await this.materializeFullOverride(repo, projected, actor.workHistoryId);
      } else {
        await repo.delete({ domainKey });
        await this.insertRows(repo, domainKey, desired, actor.workHistoryId);
      }

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'tool_binding_update',
          targetKind: 'tool_binding',
          targetId: '00000000-0000-0000-0000-000000000000',
          detail: {
            domainKey,
            before,
            after: desired,
            promotedFromCode: tableWasEmpty,
          },
        },
        manager,
      );

      const domains: ToolBindingDomainDto[] = DERIVED_DOMAIN_KEYS.map(
        (key) => ({ domainKey: key, tools: this.toDtos(projected.get(key) ?? []) }),
      );

      return {
        domainKey,
        tools: this.toDtos(desired),
        source: 'override' as const,
        domains,
      };
    });
  }

  // ── private helpers ──────────────────────────────────────────────

  /**
   * RUNTIME registry⇄domain bijection over the projected override set.
   * Mirrors the compile-time `derived-domain-map.spec.ts` checks, but at
   * save time over the OVERRIDE:
   *   1. every mapped tool ∈ `EXECUTIVE_TOOL_NAMES` (no unknown tool)
   *   2. no tool mapped to more than one domain (no double-map)
   *   3. every registry tool mapped to exactly one domain (no orphan)
   * Any violation → `400 KNOWLEDGE_TOOL_BINDING_INVALID` with the
   * offending names; integrity, not permission (§17.11).
   */
  private assertBijection(projected: Map<string, string[]>): void {
    const registered = new Set<string>(EXECUTIVE_TOOL_NAMES);
    const occurrences = this.countOccurrences(projected);

    // (1) unknown tool — a name not in the frozen registry.
    const unknownTools = [...occurrences.keys()].filter(
      (name) => !registered.has(name),
    );
    if (unknownTools.length > 0) {
      throw this.bindingInvalid('unknownTools', unknownTools, {
        message:
          'มีเครื่องมือที่ไม่อยู่ในรายการเครื่องมือของระบบ (tool ไม่ถูกต้อง)',
      });
    }

    // (2) double-map — a tool bound to more than one domain.
    const doubleMapped = [...occurrences.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);
    if (doubleMapped.length > 0) {
      throw this.bindingInvalid('doubleMappedTools', doubleMapped, {
        message:
          'มีเครื่องมือที่ถูกผูกซ้ำมากกว่าหนึ่งหมวด (double-map ไม่อนุญาต)',
      });
    }

    // (3) orphan — a registry tool not mapped to any domain.
    const orphanTools = EXECUTIVE_TOOL_NAMES.filter(
      (name) => (occurrences.get(name) ?? 0) === 0,
    );
    if (orphanTools.length > 0) {
      throw this.bindingInvalid('orphanTools', [...orphanTools], {
        message:
          'การผูกนี้ทำให้มีเครื่องมือที่ไม่ถูกผูกกับหมวดใดเลย (orphan ไม่อนุญาต)',
      });
    }
  }

  private bindingInvalid(
    field: string,
    names: string[],
    opts: { message: string },
  ): BadRequestException {
    return new BadRequestException({
      code: 'KNOWLEDGE_TOOL_BINDING_INVALID',
      message: opts.message,
      field,
      [field]: names,
    });
  }

  /** `:domainKey` must be a DERIVED (tool-backed) code domain. */
  private assertDerivedDomainKey(domainKey: string): void {
    if (!DERIVED_DOMAIN_KEYS.includes(domainKey)) {
      throw new BadRequestException({
        code: 'KNOWLEDGE_TOOL_BINDING_INVALID',
        message:
          'ไม่พบหมวด derived ที่ระบุ — ผูกเครื่องมือได้เฉพาะหมวดที่มาจากระบบ (domainKey ไม่ถูกต้อง)',
        field: 'domainKey',
        domainKey,
      });
    }
  }

  /**
   * First-ever write — persist the FULL projected override (every derived
   * domain's tool set), promoting the code map into B2. The bijection has
   * already been proven exact for `projected`, so the persisted set is
   * guaranteed complete (no orphan) and double-map-free.
   */
  private async materializeFullOverride(
    repo: Repository<AiKnowledgeToolBinding>,
    projected: Map<string, string[]>,
    actorWorkHistoryId: string,
  ): Promise<void> {
    for (const [domainKey, toolNames] of projected.entries()) {
      await this.insertRows(repo, domainKey, toolNames, actorWorkHistoryId);
    }
  }

  private async insertRows(
    repo: Repository<AiKnowledgeToolBinding>,
    domainKey: string,
    toolNames: string[],
    actorWorkHistoryId: string,
  ): Promise<void> {
    if (toolNames.length === 0) return;
    await repo.insert(
      toolNames.map((toolName) => ({
        domainKey,
        toolName,
        createdByWorkHistoryId: actorWorkHistoryId,
      })),
    );
  }

  /** Count how many domains each tool name appears in. */
  private countOccurrences(byDomain: Map<string, string[]>): Map<string, number> {
    const occurrences = new Map<string, number>();
    for (const toolNames of byDomain.values()) {
      for (const name of toolNames) {
        occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
      }
    }
    return occurrences;
  }

  private dedupePreserveOrder(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of names) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }

  /** Project tool names → display metadata (unknown names degrade to bare). */
  private toDtos(names: readonly string[]): KnowledgeMapToolDto[] {
    return names.map(
      (name) =>
        this.toolMetaByName.get(name) ?? {
          name,
          thaiLabel: name,
          description: '',
        },
    );
  }

  /**
   * Resolve the acting super-admin's CURRENT WorkHistory (§4 source of
   * truth) — uuid for the audit trail + role name denormalized at action
   * time. The guard chain (Jwt → Roles(SUPER_ADMIN_ONLY) → WorkStatus) has
   * already admitted the caller; this is the §17.3 actor-identity read,
   * NOT a second permission gate.
   */
  private async resolveActor(
    userId: string,
  ): Promise<KnowledgeToolBindingActor> {
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
}
