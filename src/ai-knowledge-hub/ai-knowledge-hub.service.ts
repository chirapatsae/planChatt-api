import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { EntityManager, Repository } from 'typeorm';

import {
  EXECUTIVE_TOOL_NAMES,
  EXECUTIVE_TOOL_REGISTRY,
} from 'src/ai-executive-chat/tools/tool-registry';
import { Role } from 'src/auth/roles.enum';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { CreateKnowledgeEntryDto } from './dto/create-knowledge-entry.dto';
import {
  KNOWLEDGE_LIST_DEFAULT_LIMIT,
  KNOWLEDGE_LIST_MAX_LIMIT,
  KnowledgeEntryDeleteResponseDto,
  KnowledgeEntryDto,
  KnowledgeEntryListResponseDto,
  KnowledgeEntryRevisionDto,
  ListKnowledgeEntriesQueryDto,
} from './dto/list-knowledge-entry.dto';
import {
  KnowledgeCoverageGapDto,
  KnowledgeMapDomainDto,
  KnowledgeMapResponseDto,
  KnowledgeMapToolDto,
} from './dto/knowledge-map.dto';
import {
  KnowledgeStructureCatalogRelationDto,
  KnowledgeStructureCatalogTableDto,
  KnowledgeStructureDomainDto,
  KnowledgeStructureResponseDto,
} from './dto/knowledge-structure.dto';
import { UpdateKnowledgeEntryDto } from './dto/update-knowledge-entry.dto';
import { AiKnowledgeEntry } from './entities/ai-knowledge-entry.entity';
import { AiKnowledgeEntryRevision } from './entities/ai-knowledge-entry-revision.entity';
import { AiKnowledgeSource } from './entities/ai-knowledge-source.entity';
import { AiKnowledgeDomainMeta } from './entities/ai-knowledge-domain-meta.entity';
import { AiKnowledgeCatalogTable } from './entities/ai-knowledge-catalog-table.entity';
import { AiKnowledgeCatalogColumn } from './entities/ai-knowledge-catalog-column.entity';
import { AiKnowledgeCatalogRelation } from './entities/ai-knowledge-catalog-relation.entity';
import { AiKnowledgeToolBinding } from './entities/ai-knowledge-tool-binding.entity';
import {
  ALL_KNOWLEDGE_DOMAIN_KEYS,
  COVERAGE_GAPS,
  CURATED_DOMAINS,
  KNOWLEDGE_DOMAIN_EDITABLE_BY,
  KNOWLEDGE_DOMAINS,
  KnowledgeCoverageGap,
  KnowledgeDomainDescriptor,
} from './registry/derived-domain-map';
import { KnowledgeAuditService } from './services/knowledge-audit.service';
import {
  KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  KNOWLEDGE_SEARCH_MAX_RESULTS,
  KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS,
  KnowledgeSearchService,
} from './services/knowledge-search.service';
import {
  SearchPreviewDto,
  SearchPreviewResponseDto,
} from './dto/search-preview.dto';
import { AiKnowledgeClassification } from './types/ai-knowledge-classification.enum';

/** Static mind-map center-node label (architecture report §3). */
export const KNOWLEDGE_MAP_CENTER_LABEL = 'Project Bank AI Chat';

/**
 * BE-02 (§17.4 discipline) — canonical content hash for a curated
 * knowledge entry: SHA-256 hex over the NFC-normalized `title` +
 * `body_md`, joined by a NUL separator so the (title, body) boundary is
 * unambiguous (`('ab','c')` never collides with `('a','bc')`).
 *
 * The TEXT IS NOT TRIMMED and NOT sanitized — entries are stored
 * verbatim (§17.9 wrapping happens at consumption, BE-04); the hash
 * mirrors exactly what is stored, modulo NFC (Thai-text stability per
 * the `content-hash.ts` precedent).
 */
export function computeKnowledgeContentHash(
  title: string,
  bodyMd: string,
): string {
  const normalizedTitle = (title ?? '').normalize('NFC');
  const normalizedBody = (bodyMd ?? '').normalize('NFC');
  return createHash('sha256')
    .update(`${normalizedTitle}\u0000${normalizedBody}`, 'utf8')
    .digest('hex');
}

/** Resolved acting admin — WorkHistory uuid + role name at action time. */
interface KnowledgeActor {
  workHistoryId: string;
  roleName: string;
}

interface DomainStatusCountRow {
  domainKey: string;
  status: string;
  count: string;
}

interface DomainFreshnessRow {
  domainKey: string;
  lastUpdatedAt: Date | string | null;
}

interface DomainSourceCountRow {
  domainKey: string;
  count: string;
}

/**
 * Wave wave-ai-knowledge-hub — BE-01 (2026-06-12).
 *
 * AiKnowledgeHubService — map read aggregator for the executive
 * mind-map (`GET /v1/ai-knowledge-hub/map`).
 *
 * CLAUDE.md references:
 *   - §17.15.6 / §18.13 discipline — this read path is ZERO-WRITE: no
 *     `tracking_status` insert, no `ai_*` write, no notification
 *     dispatch, no row mutation of any kind. The method body issues
 *     grouped SELECTs only; the zero-write invariant is spec-asserted
 *     in `__tests__/derived-domain-map.spec.ts`.
 *   - §17.15.2(a) — derived layer projected from the frozen
 *     `EXECUTIVE_TOOL_REGISTRY` via `derived-domain-map.ts` (read-only
 *     import; the registry file is never modified here).
 *   - §17.2 — counts/freshness are advisory display data; nothing in
 *     this payload gates any workflow.
 *   - §17.5 — `lastUpdatedAt` is freshness DISPLAY only; the service
 *     never recomputes or mutates anything in response to drift.
 *
 * BE-02 (curated CRUD) extends this service with entry lifecycle
 * methods; the map projection stays read-only regardless.
 */
@Injectable()
export class AiKnowledgeHubService {
  constructor(
    @InjectRepository(AiKnowledgeEntry)
    private readonly entryRepository: Repository<AiKnowledgeEntry>,
    /** BE-02 — immutable revision history (read path; writes are tx-scoped). */
    @InjectRepository(AiKnowledgeEntryRevision)
    private readonly revisionRepository: Repository<AiKnowledgeEntryRevision>,
    /**
     * BE-02 — actor resolution per §4 / §17.3: every mutation records the
     * acting admin's CURRENT WorkHistory uuid + role name (denormalized).
     * Read-only here; no hub-entity relation is introduced.
     */
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    /** BE-02 — the single `ai_knowledge_audit_logs` writer (§17.3). */
    private readonly knowledgeAuditService: KnowledgeAuditService,
    /**
     * Retrieval-test orchestration (`POST /search-preview`) delegates the
     * RANKING to the SAME `KnowledgeSearchService.search` the AI tool
     * calls — so a preview pass guarantees the entry is in the LLM's
     * candidate set. This service stays the orchestration layer; the
     * search service stays the pure ranking layer.
     */
    private readonly knowledgeSearchService: KnowledgeSearchService,
    /**
     * Phase-2 connector registry (DB-02). Injected `@Optional()` per
     * the BE-01 feature-detect contract — the map endpoint must keep
     * returning 200 with `externalSourceCount = 0` even if a future
     * refactor unregisters the Phase-2 entities; no hard dependency on
     * Phase-2 code paths (BE-03) exists here.
     */
    @Optional()
    @InjectRepository(AiKnowledgeSource)
    private readonly sourceRepository: Repository<AiKnowledgeSource> | null = null,
    /**
     * BE-01 (structure-mgmt wave) — the Class-A display overlay
     * (`ai_knowledge_domain_meta`). Injected `@Optional()` and trailing
     * so the existing positional-constructor specs keep passing: a null
     * repo means "no overlay rows" → `getKnowledgeMap` falls back to the
     * code descriptor verbatim (overlay-not-replacement / safe fallback,
     * report §4.2). Read-only on every path here (§18.13 zero-write).
     */
    @Optional()
    @InjectRepository(AiKnowledgeDomainMeta)
    private readonly domainMetaRepository: Repository<AiKnowledgeDomainMeta> | null = null,
    /**
     * BE-01 — documentation catalog repositories for `GET /structure`.
     * All `@Optional()` + trailing (positional-spec safety) and read-only
     * here: BE-03 owns the catalog mutations. Naturally zero rows until
     * BE-03 + admin curate, so a null repo degrades to an empty catalog.
     */
    @Optional()
    @InjectRepository(AiKnowledgeCatalogTable)
    private readonly catalogTableRepository: Repository<AiKnowledgeCatalogTable> | null = null,
    @Optional()
    @InjectRepository(AiKnowledgeCatalogColumn)
    private readonly catalogColumnRepository: Repository<AiKnowledgeCatalogColumn> | null = null,
    @Optional()
    @InjectRepository(AiKnowledgeCatalogRelation)
    private readonly catalogRelationRepository: Repository<AiKnowledgeCatalogRelation> | null = null,
    /**
     * BE-04 (Phase 3, structure-mgmt wave) — the Class-B tool-binding
     * OVERRIDE table (`ai_knowledge_tool_binding`). Injected `@Optional()`
     * and trailing so the existing positional-constructor specs keep
     * passing: a null repo (or an EMPTY table) means "no override" →
     * `getStructure`'s `unmappedTools[]` falls back to the CODE map
     * (`KNOWLEDGE_DOMAINS[].toolNames`), byte-identical to pre-Phase-3
     * (task §3 — BE-01 switches to consult the resolver once Phase 3
     * lands). Read-only here (§18.13 zero-write).
     */
    @Optional()
    @InjectRepository(AiKnowledgeToolBinding)
    private readonly toolBindingRepository: Repository<AiKnowledgeToolBinding> | null = null,
  ) {}

  /**
   * Full mind-map dataset: 8 derived domains (registry projection) +
   * curated domains, each with live curated counts, external-source
   * counts, and freshness; plus the coverage-gap nodes — all MERGED with
   * the Class-A `ai_knowledge_domain_meta` display overlay (BE-01 wave;
   * report §4.2).
   *
   * Overlay-not-replacement / safe fallback (CTO decision #3): the code
   * registry stays the source of truth for WHICH domains/gaps exist and
   * (until Phase 3) their tool bindings; the overlay re-skins display
   * fields only (label overrides / description / order / colour / icon /
   * hidden). A MISSING overlay row falls back to the code descriptor
   * verbatim — so with an empty overlay table the payload is
   * byte-identical to pre-wave (fallback proof / DB-01 seed acceptance).
   *
   * Hidden domains/gaps (`is_hidden = true`) are OMITTED from the map
   * render (FE shows the full set via `GET /structure`). UI-added gap
   * rows (`node_kind = 'gap'`) are merged with the code `COVERAGE_GAPS`,
   * de-duped by key (overlay wins on collision), then ordered by
   * `displayOrder`.
   *
   * ZERO writes — four grouped SELECTs total (entry counts, entry
   * freshness, source counts, overlay rows), all soft-delete-filtered.
   */
  async getKnowledgeMap(): Promise<KnowledgeMapResponseDto> {
    const [countRows, freshnessRows, sourceRows, overlayRows] =
      await Promise.all([
        this.loadEntryCountsByDomainAndStatus(),
        this.loadEntryFreshnessByDomain(),
        this.loadSourceCountsByDomain(),
        this.loadDomainMetaOverlay(),
      ]);

    const publishedByDomain = new Map<string, number>();
    const draftByDomain = new Map<string, number>();
    for (const row of countRows) {
      const count = Number(row.count) || 0;
      if (row.status === 'published') {
        publishedByDomain.set(row.domainKey, count);
      } else if (row.status === 'draft') {
        draftByDomain.set(row.domainKey, count);
      }
      // `archived` rows are deliberately not counted on the map —
      // they are neither prompt-eligible (§17.15.4) nor authorable
      // surface; freshness still includes them below.
    }

    const lastUpdatedByDomain = new Map<string, string>();
    for (const row of freshnessRows) {
      if (!row.lastUpdatedAt) continue;
      const iso =
        row.lastUpdatedAt instanceof Date
          ? row.lastUpdatedAt.toISOString()
          : new Date(row.lastUpdatedAt).toISOString();
      lastUpdatedByDomain.set(row.domainKey, iso);
    }

    const sourceCountByDomain = new Map<string, number>();
    for (const row of sourceRows) {
      sourceCountByDomain.set(row.domainKey, Number(row.count) || 0);
    }

    const overlayByKey = this.indexOverlayByKey(overlayRows);

    const domains: KnowledgeMapDomainDto[] = [
      ...KNOWLEDGE_DOMAINS,
      ...CURATED_DOMAINS,
    ]
      .map((descriptor, codeIndex) =>
        this.toDomainDto(
          descriptor,
          publishedByDomain,
          draftByDomain,
          lastUpdatedByDomain,
          sourceCountByDomain,
          overlayByKey.get(descriptor.key) ?? null,
          codeIndex,
        ),
      )
      // Hidden domains are omitted from the MAP render (the editor sees
      // them via GET /structure). Default order = code declaration
      // order; an overlay `display_order` re-positions the node. The
      // sort is stable, so equal-order peers keep code order.
      .filter((domain) => !domain.isHidden)
      .sort((a, b) => a.displayOrder - b.displayOrder);

    const coverageGaps = this.mergeCoverageGaps(overlayRows)
      .filter((gap) => !gap.isHidden)
      .sort((a, b) => a.displayOrder - b.displayOrder);

    return {
      centerLabel: KNOWLEDGE_MAP_CENTER_LABEL,
      asOf: new Date().toISOString(),
      domains,
      coverageGaps,
    };
  }

  private toDomainDto(
    descriptor: KnowledgeDomainDescriptor,
    publishedByDomain: Map<string, number>,
    draftByDomain: Map<string, number>,
    lastUpdatedByDomain: Map<string, string>,
    sourceCountByDomain: Map<string, number>,
    overlay: AiKnowledgeDomainMeta | null,
    codeOrder = 0,
  ): KnowledgeMapDomainDto {
    return {
      key: descriptor.key,
      // Overlay override ?? code (overlay-not-replacement). A blank
      // string override is treated as "set" intentionally — the seed
      // leaves overrides NULL, so only an explicit admin edit reaches
      // here.
      labelTh: overlay?.labelThOverride ?? descriptor.labelTh,
      labelEn: overlay?.labelEnOverride ?? descriptor.labelEn,
      layer: descriptor.layer,
      tools: this.toToolDtos(descriptor),
      curatedCounts: {
        published: publishedByDomain.get(descriptor.key) ?? 0,
        draft: draftByDomain.get(descriptor.key) ?? 0,
      },
      externalSourceCount: sourceCountByDomain.get(descriptor.key) ?? 0,
      lastUpdatedAt: lastUpdatedByDomain.get(descriptor.key) ?? null,
      editableBy: [...KNOWLEDGE_DOMAIN_EDITABLE_BY],
      description: overlay?.descriptionTh ?? null,
      displayOrder: overlay?.displayOrder ?? codeOrder,
      colorToken: overlay?.colorToken ?? null,
      iconKey: overlay?.iconKey ?? null,
      isHidden: overlay?.isHidden ?? false,
    };
  }

  /** Read-only registry → tool-metadata projection (shared map + structure). */
  private toToolDtos(
    descriptor: KnowledgeDomainDescriptor,
  ): KnowledgeMapToolDto[] {
    return descriptor.toolNames.map((toolName) => {
      const spec = EXECUTIVE_TOOL_REGISTRY[toolName];
      return {
        name: spec.name,
        thaiLabel: spec.thaiLabel,
        description: spec.description,
      };
    });
  }

  /**
   * Merge code `COVERAGE_GAPS` with UI-added `node_kind = 'gap'` overlay
   * rows, de-duped by key (overlay wins — it carries the live label /
   * reason / order / hidden). A pure code gap with no overlay row falls
   * back to code values + code-declaration order.
   */
  private mergeCoverageGaps(
    overlayRows: AiKnowledgeDomainMeta[],
  ): KnowledgeCoverageGapDto[] {
    const overlayByKey = new Map<string, AiKnowledgeDomainMeta>();
    for (const row of overlayRows) {
      if (row.nodeKind === 'gap') overlayByKey.set(row.domainKey, row);
    }

    const merged = new Map<string, KnowledgeCoverageGapDto>();

    // Code gaps first — keep code-declaration order as the default.
    COVERAGE_GAPS.forEach((gap: KnowledgeCoverageGap, index) => {
      const overlay = overlayByKey.get(gap.key);
      merged.set(gap.key, {
        key: gap.key,
        labelTh: overlay?.labelThOverride ?? gap.labelTh,
        reason: overlay?.gapReasonTh ?? gap.reason,
        displayOrder: overlay?.displayOrder ?? index,
        isHidden: overlay?.isHidden ?? false,
      });
    });

    // UI-added gaps that are NOT also code gaps.
    for (const [key, overlay] of overlayByKey.entries()) {
      if (merged.has(key)) continue;
      merged.set(key, {
        key,
        labelTh: overlay.labelThOverride ?? key,
        reason: overlay.gapReasonTh ?? '',
        displayOrder: overlay.displayOrder,
        isHidden: overlay.isHidden,
      });
    }

    return [...merged.values()];
  }

  /** Index non-deleted overlay rows by `domain_key` for O(1) merge lookup. */
  private indexOverlayByKey(
    overlayRows: AiKnowledgeDomainMeta[],
  ): Map<string, AiKnowledgeDomainMeta> {
    const byKey = new Map<string, AiKnowledgeDomainMeta>();
    for (const row of overlayRows) {
      if (row.nodeKind === 'domain') byKey.set(row.domainKey, row);
    }
    return byKey;
  }

  /**
   * Grouped SELECT — all non-deleted `ai_knowledge_domain_meta` rows.
   * Degrades to `[]` when the overlay repository is absent (feature-
   * detect — a null repo means "no overlay" → pure code fallback, the
   * safe day-zero state). ZERO-WRITE.
   */
  private async loadDomainMetaOverlay(): Promise<AiKnowledgeDomainMeta[]> {
    if (!this.domainMetaRepository) return [];
    return this.domainMetaRepository
      .createQueryBuilder('meta')
      .where('meta.deletedAt IS NULL')
      .orderBy('meta.displayOrder', 'ASC')
      .getMany();
  }

  /**
   * BE-04 (Phase 3) — resolve the FLAT set of tool names mapped to ANY
   * derived domain, consulting the `ai_knowledge_tool_binding` OVERRIDE
   * (B2) when it has rows, else the code map `KNOWLEDGE_DOMAINS[].toolNames`
   * (B1 fallback, task §3 / §6). A null repo or an empty table → the code
   * map, so `unmappedTools[]` is byte-identical to the pre-Phase-3
   * contract. ZERO-WRITE (SELECT only; mirrors the resolver in
   * `KnowledgeToolBindingService.resolveBindingMap`).
   */
  private async resolveMappedToolNames(): Promise<string[]> {
    const codeMapped = (): string[] =>
      KNOWLEDGE_DOMAINS.flatMap((domain) => [...domain.toolNames]);

    if (!this.toolBindingRepository) return codeMapped();
    const overrideRows = await this.toolBindingRepository.find();
    if (overrideRows.length === 0) return codeMapped();
    return overrideRows.map((row) => row.toolName);
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-01 (structure-mgmt wave, 2026-06-13) — `GET /structure` read
  // aggregator. The SINGLE dataset the visual editors (FE-01 / FE-02)
  // consume: code descriptors merged with the display overlay + the
  // documentation catalog + the read-only tool registry + the orphan
  // detector. ZERO-WRITE (§18.13 condition 2) — grouped SELECTs only.
  // ──────────────────────────────────────────────────────────────────

  /**
   * `GET /v1/ai-knowledge-hub/structure` — full editable structure
   * dataset (report §4.3). EXEC_READ (Q-06). ZERO-WRITE.
   *
   * Unlike `GET /map`, this returns the COMPLETE set including hidden
   * nodes (the editor toggles visibility) and carries the unmerged code
   * labels (`codeLabelTh` / `codeLabelEn`) so the FE can offer
   * "คืนค่าจากระบบ". The `tools[]` list per domain is read-only registry
   * metadata; `toolRegistry[]` is the full valid pick-list for the
   * Phase-3 binding editor; `unmappedTools[]` is the orphan detector.
   *
   * §17.16 overlay-not-replacement + Q-05: every domain node is
   * code-origin (`codeOrigin: true`) — the editor may reorder / hide /
   * relabel / recolour but NEVER add or delete a code-origin domain.
   *
   * Tool binding resolves through the BE-04 OVERRIDE seam (task §3):
   * `unmappedTools` is computed against the RESOLVED binding — the
   * `ai_knowledge_tool_binding` override set when any row exists, else the
   * code fallback (`KNOWLEDGE_DOMAINS[].toolNames`). With an EMPTY override
   * table (or no override repo registered) this is byte-identical to the
   * pre-Phase-3 code-only contract.
   */
  async getStructure(): Promise<KnowledgeStructureResponseDto> {
    const [
      overlayRows,
      catalogTables,
      catalogColumns,
      catalogRelations,
      mappedToolNames,
    ] = await Promise.all([
      this.loadDomainMetaOverlay(),
      this.loadCatalogTables(),
      this.loadCatalogColumns(),
      this.loadCatalogRelations(),
      this.resolveMappedToolNames(),
    ]);

    const overlayByKey = this.indexOverlayByKey(overlayRows);

    // Editor view: ALL domains incl. hidden, ordered by overlay
    // `display_order` (code-declaration order as the pre-seed default).
    const domains: KnowledgeStructureDomainDto[] = [
      ...KNOWLEDGE_DOMAINS,
      ...CURATED_DOMAINS,
    ]
      .map((descriptor, codeIndex) => {
        const overlay = overlayByKey.get(descriptor.key) ?? null;
        return {
          key: descriptor.key,
          labelTh: overlay?.labelThOverride ?? descriptor.labelTh,
          labelEn: overlay?.labelEnOverride ?? descriptor.labelEn,
          codeLabelTh: descriptor.labelTh,
          codeLabelEn: descriptor.labelEn,
          layer: descriptor.layer,
          description: overlay?.descriptionTh ?? null,
          displayOrder: overlay?.displayOrder ?? codeIndex,
          colorToken: overlay?.colorToken ?? null,
          iconKey: overlay?.iconKey ?? null,
          isHidden: overlay?.isHidden ?? false,
          codeOrigin: true as const,
          tools: this.toToolDtos(descriptor),
          editableBy: [...KNOWLEDGE_DOMAIN_EDITABLE_BY],
          hasOverlay: overlay !== null,
        };
      })
      .sort((a, b) => a.displayOrder - b.displayOrder);

    // Gaps: code + UI-added, merged (incl. hidden for the editor).
    const gaps = this.mergeCoverageGaps(overlayRows).sort(
      (a, b) => a.displayOrder - b.displayOrder,
    );

    // Tool registry — full read-only pick-list (every registered tool).
    const toolRegistry: KnowledgeMapToolDto[] = EXECUTIVE_TOOL_NAMES.map(
      (toolName) => {
        const spec = EXECUTIVE_TOOL_REGISTRY[toolName];
        return {
          name: spec.name,
          thaiLabel: spec.thaiLabel,
          description: spec.description,
        };
      },
    );

    // Orphan detector — registry tools absent from every domain's
    // RESOLVED binding (BE-04 override set when present, else the code
    // map). Empty when the bijection holds; a non-empty list means a tool
    // wave skipped the map OR an override left a tool orphaned (the latter
    // is forbidden at PUT time by the runtime bijection guard, so it can
    // only arise from an out-of-band DB edit — surfaced honestly here).
    const mapped = new Set<string>(mappedToolNames);
    const unmappedTools: KnowledgeMapToolDto[] = toolRegistry.filter(
      (tool) => !mapped.has(tool.name),
    );

    // Stale overlay keys — `node_kind = 'domain'` overlay rows whose key
    // is not in the code registry (task §8). The merge already ignores
    // them (code is the existence source of truth); surface for cleanup.
    const knownKeys = new Set<string>(ALL_KNOWLEDGE_DOMAIN_KEYS);
    const staleOverlayKeys = overlayRows
      .filter(
        (row) => row.nodeKind === 'domain' && !knownKeys.has(row.domainKey),
      )
      .map((row) => row.domainKey);

    return {
      centerLabel: KNOWLEDGE_MAP_CENTER_LABEL,
      asOf: new Date().toISOString(),
      domains,
      gaps,
      catalog: {
        tables: this.assembleCatalog(catalogTables, catalogColumns),
        relations: catalogRelations.map((relation) =>
          this.toCatalogRelationDto(relation),
        ),
      },
      toolRegistry,
      unmappedTools,
      staleOverlayKeys,
    };
  }

  /**
   * Nest non-deleted catalog columns under their parent table, both
   * ordered by `display_order`. A column whose parent table is absent
   * (or soft-deleted) is dropped — the catalog tree never dangles.
   */
  private assembleCatalog(
    tables: AiKnowledgeCatalogTable[],
    columns: AiKnowledgeCatalogColumn[],
  ): KnowledgeStructureCatalogTableDto[] {
    const columnsByTable = new Map<string, AiKnowledgeCatalogColumn[]>();
    for (const column of columns) {
      const list = columnsByTable.get(column.tableId);
      if (list) list.push(column);
      else columnsByTable.set(column.tableId, [column]);
    }

    return tables.map((table) => ({
      id: table.id,
      tableName: table.tableName,
      displayNameTh: table.displayNameTh,
      description: table.descriptionTh ?? null,
      domainKey: table.domainKey ?? null,
      isSeeded: table.isSeeded,
      displayOrder: table.displayOrder,
      columns: (columnsByTable.get(table.id) ?? []).map((column) => ({
        id: column.id,
        columnName: column.columnName,
        dataType: column.dataType ?? null,
        isNullable: column.isNullable,
        description: column.descriptionTh ?? null,
        isPii: column.isPii,
        displayOrder: column.displayOrder,
      })),
    }));
  }

  private toCatalogRelationDto(
    relation: AiKnowledgeCatalogRelation,
  ): KnowledgeStructureCatalogRelationDto {
    return {
      id: relation.id,
      fromTableId: relation.fromTableId,
      toTableId: relation.toTableId,
      relationType: relation.relationType,
      labelTh: relation.labelTh ?? null,
      onDeleteNote: relation.onDeleteNote ?? null,
      displayOrder: relation.displayOrder,
    };
  }

  /** Non-deleted catalog tables, domain + order. ZERO-WRITE. Degrades to []. */
  private async loadCatalogTables(): Promise<AiKnowledgeCatalogTable[]> {
    if (!this.catalogTableRepository) return [];
    return this.catalogTableRepository
      .createQueryBuilder('tbl')
      .where('tbl.deletedAt IS NULL')
      .orderBy('tbl.displayOrder', 'ASC')
      .addOrderBy('tbl.tableName', 'ASC')
      .getMany();
  }

  /** Non-deleted catalog columns, by display order. ZERO-WRITE. Degrades to []. */
  private async loadCatalogColumns(): Promise<AiKnowledgeCatalogColumn[]> {
    if (!this.catalogColumnRepository) return [];
    return this.catalogColumnRepository
      .createQueryBuilder('col')
      .where('col.deletedAt IS NULL')
      .orderBy('col.displayOrder', 'ASC')
      .getMany();
  }

  /** Non-deleted catalog relations, by display order. ZERO-WRITE. Degrades to []. */
  private async loadCatalogRelations(): Promise<AiKnowledgeCatalogRelation[]> {
    if (!this.catalogRelationRepository) return [];
    return this.catalogRelationRepository
      .createQueryBuilder('rel')
      .where('rel.deletedAt IS NULL')
      .orderBy('rel.displayOrder', 'ASC')
      .getMany();
  }

  /** Grouped COUNT #1 — entries per (domain_key, status), non-deleted. */
  private loadEntryCountsByDomainAndStatus(): Promise<DomainStatusCountRow[]> {
    return this.entryRepository
      .createQueryBuilder('entry')
      .select('entry.domainKey', 'domainKey')
      .addSelect('entry.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('entry.deletedAt IS NULL')
      .groupBy('entry.domainKey')
      .addGroupBy('entry.status')
      .getRawMany<DomainStatusCountRow>();
  }

  /** Grouped COUNT #2 — MAX(updated_at) per domain_key, non-deleted. */
  private loadEntryFreshnessByDomain(): Promise<DomainFreshnessRow[]> {
    return this.entryRepository
      .createQueryBuilder('entry')
      .select('entry.domainKey', 'domainKey')
      .addSelect('MAX(entry.updatedAt)', 'lastUpdatedAt')
      .where('entry.deletedAt IS NULL')
      .groupBy('entry.domainKey')
      .getRawMany<DomainFreshnessRow>();
  }

  /**
   * Source counts per target_domain_key (Phase-2 data; naturally zero
   * rows until BE-03 registers sources). Degrades to `[]` when the
   * repository is absent — feature-detect, not hard import.
   */
  private async loadSourceCountsByDomain(): Promise<DomainSourceCountRow[]> {
    if (!this.sourceRepository) return [];
    return this.sourceRepository
      .createQueryBuilder('source')
      .select('source.targetDomainKey', 'domainKey')
      .addSelect('COUNT(*)', 'count')
      .where('source.deletedAt IS NULL')
      .groupBy('source.targetDomainKey')
      .getRawMany<DomainSourceCountRow>();
  }

  /**
   * `POST /v1/ai-knowledge-hub/search-preview` — deterministic, zero-cost
   * "retrieval test" (admin + super-admin only per §17.11).
   *
   * Runs the SAME `KnowledgeSearchService.search` ranking the AI tool
   * uses, so a pass here GUARANTEES the entry is in the candidate set the
   * LLM would receive — without spending any LLM tokens. ZERO writes
   * (§18.13 discipline): one ranking read, no mutation of any kind.
   * Advisory only (§17.2) — nothing here gates any workflow.
   *
   * Mechanics:
   *   - `aiVisibleLimit` = the top-k the AI tool would actually pass
   *     (requested `limit` or default 3, capped at
   *     {@link KNOWLEDGE_SEARCH_MAX_RESULTS} = 5).
   *   - the diagnostic call widens the row window to
   *     {@link KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS} via
   *     `maxResultsOverride` so `targetRank` can be computed across the
   *     full ranked candidate set; the published-only + soft-delete
   *     predicates are UNCHANGED (the override only raises the LIMIT).
   *   - `items` = the first `aiVisibleLimit` of that ranked list — exactly
   *     what the LLM sees.
   *   - `targetRank` = 1-based index of `expectEntryId` in the full ranked
   *     list, or null when it does not match the query / is not a live
   *     published entry (published-only still holds on the preview path).
   */
  async searchPreview(
    dto: SearchPreviewDto,
  ): Promise<SearchPreviewResponseDto> {
    const aiVisibleLimit = Math.min(
      dto.limit ?? KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
      KNOWLEDGE_SEARCH_MAX_RESULTS,
    );

    // SAME ranking SQL as the AI tool — only the LIMIT is widened (the
    // published-only + soft-delete predicates are baked in for BOTH
    // paths). A draft / archived / soft-deleted entry can therefore
    // NEVER appear in the candidate list nor receive a `targetRank`.
    //
    // We request `limit = PREVIEW_MAX` AND pass the same value as the
    // ceiling override — the requested limit is clamped to the override
    // ceiling, so this fills the full diagnostic window (the default
    // top-k of 3 would otherwise cap the candidate set before
    // `targetRank` could see a deep entry).
    const ranked = await this.knowledgeSearchService.search(
      {
        query: dto.query,
        domainKey: dto.domainKey,
        limit: KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS,
      },
      { maxResultsOverride: KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS },
    );

    const targetIndex = dto.expectEntryId
      ? ranked.items.findIndex((item) => item.entryId === dto.expectEntryId)
      : -1;

    return {
      items: ranked.items.slice(0, aiVisibleLimit),
      aiVisibleLimit,
      targetRank: targetIndex >= 0 ? targetIndex + 1 : null,
      asOf: ranked.asOf,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-02 — curated knowledge CRUD + lifecycle (Wave wave-ai-knowledge-
  // hub, 2026-06-12). Mutations are admin + super-admin only (Q2 LOCKED
  // — enforced at the controller via @Roles(...ADMIN_OR_ABOVE)); every
  // mutation writes EXACTLY ONE `ai_knowledge_audit_logs` row inside
  // the same transaction (§17.3 — never TrackingStatus). Read methods
  // are ZERO-WRITE (§18.13 discipline).
  // ──────────────────────────────────────────────────────────────────

  /**
   * `GET /entries` — paginated list (EXEC_READ). ZERO-WRITE.
   *
   * Visibility: non-admin callers (staff / c-level) see `published`
   * rows ONLY — any caller-supplied `status` filter is overridden.
   * Admin / super-admin may filter freely (default = all statuses).
   * Limit is hard-capped at {@link KNOWLEDGE_LIST_MAX_LIMIT} (the DTO
   * `@Max` rejects bigger values; the clamp here is belt-and-braces).
   */
  async listEntries(
    query: ListKnowledgeEntriesQueryDto,
    callerRole: string,
  ): Promise<KnowledgeEntryListResponseDto> {
    const page = query.page ?? 1;
    const limit = Math.min(
      query.limit ?? KNOWLEDGE_LIST_DEFAULT_LIMIT,
      KNOWLEDGE_LIST_MAX_LIMIT,
    );

    const qb = this.entryRepository
      .createQueryBuilder('entry')
      .where('entry.deletedAt IS NULL');

    // Non-admin → published-only, regardless of the requested filter.
    const effectiveStatus = this.isAdminRole(callerRole)
      ? query.status
      : 'published';
    if (effectiveStatus) {
      qb.andWhere('entry.status = :status', { status: effectiveStatus });
    }

    if (query.domainKey) {
      qb.andWhere('entry.domainKey = :domainKey', {
        domainKey: query.domainKey,
      });
    }

    if (query.q) {
      // pg_trgm-backed ILIKE over title + body (Q5 Thai-dominant corpus;
      // GIN trgm indexes per DB-01). LIKE metacharacters are escaped so
      // user input is always a literal needle.
      const needle = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      qb.andWhere('(entry.title ILIKE :q OR entry.bodyMd ILIKE :q)', {
        q: needle,
      });
    }

    const [rows, total] = await qb
      .orderBy('entry.updatedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      items: rows.map((row) => this.toEntryDto(row)),
      total,
      page,
      limit,
    };
  }

  /**
   * `GET /entries/:id` — single entry (EXEC_READ). ZERO-WRITE.
   *
   * Non-admin callers can read `published` entries only; a draft /
   * archived entry answers 404 (existence-hiding — same shape as a
   * genuinely missing id, so the lifecycle state never leaks).
   */
  async getEntry(id: string, callerRole: string): Promise<KnowledgeEntryDto> {
    const entry = await this.entryRepository.findOne({ where: { id } });
    if (!entry) {
      throw this.entryNotFound();
    }
    if (!this.isAdminRole(callerRole) && entry.status !== 'published') {
      throw this.entryNotFound();
    }
    return this.toEntryDto(entry);
  }

  /**
   * `GET /entries/:id/revisions` — immutable version history, newest
   * first (admin + super-admin only per Q2). ZERO-WRITE.
   */
  async listEntryRevisions(id: string): Promise<KnowledgeEntryRevisionDto[]> {
    const entry = await this.entryRepository.findOne({ where: { id } });
    if (!entry) {
      throw this.entryNotFound();
    }
    const revisions = await this.revisionRepository.find({
      where: { entryId: id },
      order: { version: 'DESC' },
    });
    return revisions.map((revision) => this.toRevisionDto(revision));
  }

  /**
   * `POST /entries` — create a curated draft (admin + super-admin, Q2).
   *
   * Atomically (single transaction):
   *   1. insert the entry — `origin = 'curated'` ALWAYS (task §3; the
   *      external origin is born only via the BE-03 promotion path),
   *      `status = 'draft'` (publish is a separate explicit action,
   *      §17.5), `current_version = 1`, §17.4 content hash;
   *   2. insert immutable revision v1 (same content + hash);
   *   3. write exactly one audit row (`action = 'create'`).
   */
  async createEntry(
    dto: CreateKnowledgeEntryDto,
    userId: string,
  ): Promise<KnowledgeEntryDto> {
    const actor = await this.resolveActor(userId);
    this.assertKnownDomainKey(dto.domainKey);

    const contentHash = computeKnowledgeContentHash(dto.title, dto.bodyMd);

    return this.entryRepository.manager.transaction(async (manager) => {
      const entryRepo = manager.getRepository(AiKnowledgeEntry);
      const saved = await entryRepo.save(
        entryRepo.create({
          domainKey: dto.domainKey,
          title: dto.title,
          bodyMd: dto.bodyMd,
          tags: dto.tags ?? [],
          origin: 'curated' as const,
          sourceId: null,
          status: 'draft' as const,
          currentVersion: 1,
          contentHash,
          language: dto.language ?? 'th',
          classification: dto.classification ?? 'internal',
          createdByWorkHistoryId: actor.workHistoryId,
          updatedByWorkHistoryId: actor.workHistoryId,
        }),
      );

      const revisionRepo = manager.getRepository(AiKnowledgeEntryRevision);
      await revisionRepo.insert({
        entryId: saved.id,
        version: 1,
        title: dto.title,
        bodyMd: dto.bodyMd,
        tags: dto.tags ?? [],
        contentHash,
        editedByWorkHistoryId: actor.workHistoryId,
      });

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'create',
          targetKind: 'entry',
          targetId: saved.id,
          detail: { domainKey: saved.domainKey, version: 1 },
        },
        manager,
      );

      return this.toEntryDto(saved);
    });
  }

  /**
   * BE-03 promotion bridge (Wave wave-ai-knowledge-hub, 2026-06-12) —
   * create an EXTERNAL-origin draft entry from a quarantined ingestion
   * (§17.15.5: explicit admin promotion is the SOLE path by which
   * external content becomes a curated entry; the entry is born
   * `draft` and walks the normal publish flow — never auto-published).
   *
   * Runs INSIDE the caller's transaction (`manager`) so the entry +
   * revision v1 + `create` audit row commit atomically with the
   * ingestion verdict that `KnowledgeIngestionService.promote` writes.
   * The actor was already resolved by the caller — promotion is one
   * action by one admin; resolving twice could race a WorkHistory flip.
   *
   * §17.9 note: `bodyMd` is stored VERBATIM (hostile by default) —
   * delimiter-wrapping happens at consumption (BE-04), not here. The
   * caller is responsible for the Q4 PII gate BEFORE invoking this.
   */
  async createExternalEntry(
    params: {
      domainKey: string;
      title: string;
      bodyMd: string;
      tags: string[];
      language?: string;
      classification: AiKnowledgeClassification;
      sourceId: string | null;
      actorWorkHistoryId: string;
      actorRole: string;
    },
    manager: EntityManager,
  ): Promise<KnowledgeEntryDto> {
    this.assertKnownDomainKey(params.domainKey);

    const contentHash = computeKnowledgeContentHash(
      params.title,
      params.bodyMd,
    );

    const entryRepo = manager.getRepository(AiKnowledgeEntry);
    const saved = await entryRepo.save(
      entryRepo.create({
        domainKey: params.domainKey,
        title: params.title,
        bodyMd: params.bodyMd,
        tags: params.tags ?? [],
        origin: 'external' as const,
        sourceId: params.sourceId,
        status: 'draft' as const,
        currentVersion: 1,
        contentHash,
        language: params.language ?? 'th',
        classification: params.classification,
        createdByWorkHistoryId: params.actorWorkHistoryId,
        updatedByWorkHistoryId: params.actorWorkHistoryId,
      }),
    );

    const revisionRepo = manager.getRepository(AiKnowledgeEntryRevision);
    await revisionRepo.insert({
      entryId: saved.id,
      version: 1,
      title: params.title,
      bodyMd: params.bodyMd,
      tags: params.tags ?? [],
      contentHash,
      editedByWorkHistoryId: params.actorWorkHistoryId,
    });

    await this.knowledgeAuditService.record(
      {
        actorWorkHistoryId: params.actorWorkHistoryId,
        actorRole: params.actorRole,
        action: 'create',
        targetKind: 'entry',
        targetId: saved.id,
        detail: {
          domainKey: saved.domainKey,
          version: 1,
          origin: 'external',
          sourceId: params.sourceId,
        },
      },
      manager,
    );

    return this.toEntryDto(saved);
  }

  /**
   * `PATCH /entries/:id` — edit (admin + super-admin, Q2).
   *
   * Optimistic concurrency (task §8): `dto.currentVersion` MUST equal
   * the live `current_version` → otherwise `409 KNOWLEDGE_VERSION_
   * CONFLICT`. The conditional UPDATE re-asserts the version inside the
   * transaction, so two racing PATCHes can never both win.
   *
   * Idempotency (§17.4 spirit / task §7): a PATCH whose merged content
   * hash equals the stored hash AND whose metadata (domainKey / tags /
   * language / classification) is unchanged is a NO-OP — the existing
   * state is returned, NO revision row, NO audit row, ZERO mutation
   * (Wave-10 idempotent short-circuit precedent).
   *
   * Any effective change inserts immutable revision vN+1 (revisions are
   * NEVER updated in place — vN is preserved byte-for-byte) and bumps
   * `current_version`. A metadata-only change (e.g. tags) is still an
   * effective edit: it writes a revision so history stays complete
   * (revision rows snapshot tags per DB-01), even though the §17.4
   * content hash — title + body only — is unchanged.
   */
  async updateEntry(
    id: string,
    dto: UpdateKnowledgeEntryDto,
    userId: string,
  ): Promise<KnowledgeEntryDto> {
    const actor = await this.resolveActor(userId);

    const entry = await this.entryRepository.findOne({ where: { id } });
    if (!entry) {
      throw this.entryNotFound();
    }

    if (dto.currentVersion !== entry.currentVersion) {
      throw this.versionConflict(entry.currentVersion);
    }

    if (dto.domainKey !== undefined) {
      this.assertKnownDomainKey(dto.domainKey);
    }

    // Merge-patch: omitted fields keep their stored value.
    const next = {
      domainKey: dto.domainKey ?? entry.domainKey,
      title: dto.title ?? entry.title,
      bodyMd: dto.bodyMd ?? entry.bodyMd,
      tags: dto.tags ?? entry.tags,
      language: dto.language ?? entry.language,
      classification: dto.classification ?? entry.classification,
    };

    const nextHash = computeKnowledgeContentHash(next.title, next.bodyMd);
    const contentChanged = nextHash !== entry.contentHash;
    const metadataChanged =
      next.domainKey !== entry.domainKey ||
      next.language !== entry.language ||
      next.classification !== entry.classification ||
      !this.tagsEqual(next.tags, entry.tags);

    if (!contentChanged && !metadataChanged) {
      // Idempotent no-op — identical hash + identical metadata. ZERO
      // writes: no revision, no version bump, no audit row.
      return this.toEntryDto(entry);
    }

    const fromVersion = entry.currentVersion;
    const toVersion = fromVersion + 1;

    return this.entryRepository.manager.transaction(async (manager) => {
      // 1. Immutable revision vN+1 — snapshot of the NEW state. The
      //    UNIQUE (entry_id, version) constraint is the DB-level race
      //    backstop alongside the conditional UPDATE below.
      const revisionRepo = manager.getRepository(AiKnowledgeEntryRevision);
      await revisionRepo.insert({
        entryId: id,
        version: toVersion,
        title: next.title,
        bodyMd: next.bodyMd,
        tags: next.tags,
        contentHash: nextHash,
        editedByWorkHistoryId: actor.workHistoryId,
      });

      // 2. Conditional UPDATE — optimistic-concurrency re-assertion.
      const result = await manager
        .getRepository(AiKnowledgeEntry)
        .update(
          { id, currentVersion: fromVersion },
          {
            domainKey: next.domainKey,
            title: next.title,
            bodyMd: next.bodyMd,
            tags: next.tags,
            language: next.language,
            classification: next.classification,
            contentHash: nextHash,
            currentVersion: toVersion,
            updatedByWorkHistoryId: actor.workHistoryId,
          },
        );
      if (!result.affected) {
        // A concurrent editor won the race after our read — abort; the
        // transaction rolls the revision insert back too.
        throw this.versionConflict();
      }

      // 3. Exactly one audit row (§17.3).
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'update',
          targetKind: 'entry',
          targetId: id,
          detail: { fromVersion, toVersion, contentChanged, metadataChanged },
        },
        manager,
      );

      return this.toEntryDto({
        ...entry,
        ...next,
        contentHash: nextHash,
        currentVersion: toVersion,
        updatedByWorkHistoryId: actor.workHistoryId,
        updatedAt: new Date(),
      });
    });
  }

  /**
   * `POST /entries/:id/publish` — draft → published (admin + super-
   * admin, Q2; §17.5 — publishing is an explicit human action; only
   * published entries are chat-visible via BE-04).
   */
  async publishEntry(id: string, userId: string): Promise<KnowledgeEntryDto> {
    return this.transitionEntryStatus(id, userId, 'draft', 'published', {
      action: 'publish',
      thaiError:
        'เผยแพร่ได้เฉพาะองค์ความรู้สถานะฉบับร่าง (draft) เท่านั้น',
    });
  }

  /**
   * `POST /entries/:id/archive` — published → archived (admin + super-
   * admin, Q2). Archived entries leave the chat-visible corpus.
   */
  async archiveEntry(id: string, userId: string): Promise<KnowledgeEntryDto> {
    return this.transitionEntryStatus(id, userId, 'published', 'archived', {
      action: 'archive',
      thaiError:
        'เก็บถาวรได้เฉพาะองค์ความรู้สถานะเผยแพร่แล้ว (published) เท่านั้น',
    });
  }

  /**
   * `DELETE /entries/:id` — soft delete (admin + super-admin, Q2).
   *
   * The audit row is written BEFORE `deletedAt` flips, inside the same
   * transaction (tombstone-before-delete, §18 spirit). Revisions stay
   * intact — soft delete never destroys history.
   */
  async deleteEntry(
    id: string,
    userId: string,
  ): Promise<KnowledgeEntryDeleteResponseDto> {
    const actor = await this.resolveActor(userId);

    const entry = await this.entryRepository.findOne({ where: { id } });
    if (!entry) {
      throw this.entryNotFound();
    }

    return this.entryRepository.manager.transaction(async (manager) => {
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'delete',
          targetKind: 'entry',
          targetId: id,
          detail: {
            statusAtDelete: entry.status,
            versionAtDelete: entry.currentVersion,
          },
        },
        manager,
      );

      await manager.getRepository(AiKnowledgeEntry).softDelete({ id });

      return { id, deleted: true as const };
    });
  }

  // ── BE-02 private helpers ────────────────────────────────────────

  /**
   * Shared lifecycle transition (publish / archive). The transition
   * table is STRICT per task §3: `draft → published`, `published →
   * archived` — nothing else. Wrong current status → `409
   * KNOWLEDGE_STATUS_INVALID`.
   */
  private async transitionEntryStatus(
    id: string,
    userId: string,
    requiredStatus: 'draft' | 'published',
    nextStatus: 'published' | 'archived',
    options: { action: 'publish' | 'archive'; thaiError: string },
  ): Promise<KnowledgeEntryDto> {
    const actor = await this.resolveActor(userId);

    const entry = await this.entryRepository.findOne({ where: { id } });
    if (!entry) {
      throw this.entryNotFound();
    }

    if (entry.status !== requiredStatus) {
      throw new ConflictException({
        code: 'KNOWLEDGE_STATUS_INVALID',
        message: options.thaiError,
        currentStatus: entry.status,
      });
    }

    return this.entryRepository.manager.transaction(async (manager) => {
      await manager
        .getRepository(AiKnowledgeEntry)
        .update(
          { id },
          {
            status: nextStatus,
            updatedByWorkHistoryId: actor.workHistoryId,
          },
        );

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: options.action,
          targetKind: 'entry',
          targetId: id,
          detail: { from: requiredStatus, to: nextStatus },
        },
        manager,
      );

      return this.toEntryDto({
        ...entry,
        status: nextStatus,
        updatedByWorkHistoryId: actor.workHistoryId,
        updatedAt: new Date(),
      });
    });
  }

  /**
   * Resolve the acting admin's CURRENT WorkHistory (§4 source of truth)
   * — uuid for the audit trail + role name denormalized at action time.
   * The guard chain (JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard)
   * has already admitted the caller; this is the §17.3 actor-identity
   * read, not a second permission gate.
   */
  private async resolveActor(userId: string): Promise<KnowledgeActor> {
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

  /** `domain_key` must exist in BE-01's code-declared domain registry. */
  private assertKnownDomainKey(domainKey: string): void {
    if (!ALL_KNOWLEDGE_DOMAIN_KEYS.includes(domainKey)) {
      throw new BadRequestException({
        code: 'KNOWLEDGE_DOMAIN_UNKNOWN',
        message: 'ไม่พบหมวดองค์ความรู้ที่ระบุ (domainKey ไม่ถูกต้อง)',
        domainKey,
      });
    }
  }

  private isAdminRole(role: string): boolean {
    return role === Role.ADMIN || role === Role.SUPER_ADMIN;
  }

  private tagsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((tag, index) => tag === b[index]);
  }

  private entryNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'KNOWLEDGE_ENTRY_NOT_FOUND',
      message: 'ไม่พบองค์ความรู้ที่ระบุ',
    });
  }

  private versionConflict(currentVersion?: number): ConflictException {
    return new ConflictException({
      code: 'KNOWLEDGE_VERSION_CONFLICT',
      message:
        'ข้อมูลถูกแก้ไขโดยผู้ใช้อื่นแล้ว กรุณาโหลดเวอร์ชันล่าสุดก่อนแก้ไขอีกครั้ง',
      ...(currentVersion !== undefined ? { currentVersion } : {}),
    });
  }

  private toEntryDto(entry: AiKnowledgeEntry): KnowledgeEntryDto {
    return {
      id: entry.id,
      domainKey: entry.domainKey,
      title: entry.title,
      bodyMd: entry.bodyMd,
      tags: entry.tags ?? [],
      origin: entry.origin,
      sourceId: entry.sourceId ?? null,
      status: entry.status,
      currentVersion: entry.currentVersion,
      contentHash: entry.contentHash,
      language: entry.language,
      classification: entry.classification,
      createdByWorkHistoryId: entry.createdByWorkHistoryId,
      updatedByWorkHistoryId: entry.updatedByWorkHistoryId,
      createdAt: this.toIso(entry.createdAt),
      updatedAt: this.toIso(entry.updatedAt),
    };
  }

  private toRevisionDto(
    revision: AiKnowledgeEntryRevision,
  ): KnowledgeEntryRevisionDto {
    return {
      id: revision.id,
      entryId: revision.entryId,
      version: revision.version,
      title: revision.title,
      bodyMd: revision.bodyMd,
      tags: revision.tags ?? [],
      contentHash: revision.contentHash,
      editedByWorkHistoryId: revision.editedByWorkHistoryId,
      createdAt: this.toIso(revision.createdAt),
    };
  }

  private toIso(value: Date | string | null | undefined): string {
    if (!value) return '';
    return value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();
  }
}
