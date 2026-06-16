import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { SUPER_ADMIN_ONLY } from 'src/auth/role-groups';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';

import { AiKnowledgeHubService } from '../ai-knowledge-hub.service';
import {
  PatchKnowledgeDomainDto,
  ReorderKnowledgeDomainsDto,
} from '../dto/structure-domain.dto';
import {
  CreateKnowledgeGapDto,
  PatchKnowledgeGapDto,
} from '../dto/structure-gap.dto';
import {
  CreateCatalogTableDto,
  UpdateCatalogTableDto,
} from '../dto/catalog-table.dto';
import { UpsertCatalogColumnsDto } from '../dto/catalog-column.dto';
import {
  CreateCatalogRelationDto,
  UpdateCatalogRelationDto,
} from '../dto/catalog-relation.dto';
import { KnowledgeStructureResponseDto } from '../dto/knowledge-structure.dto';
import {
  KnowledgeDomainOverlayDto,
  KnowledgeGapDeleteResultDto,
  KnowledgeGapDto,
  KnowledgeReorderResultDto,
  KnowledgeStructureService,
} from '../services/knowledge-structure.service';
import {
  CatalogColumnUpsertResultDto,
  CatalogRelationDeleteResultDto,
  CatalogRelationDto,
  CatalogSeedResultDto,
  CatalogTableDeleteResultDto,
  CatalogTableDto,
  KnowledgeCatalogService,
} from '../services/knowledge-catalog.service';
import { PutToolBindingDto } from '../dto/tool-binding.dto';
import {
  KnowledgeToolBindingService,
  ToolBindingReadDto,
  ToolBindingWriteResultDto,
} from '../services/knowledge-tool-binding.service';

/**
 * KnowledgeStructureController — Wave wave-ai-knowledge-structure-mgmt.
 *
 * The structure / catalog management surface, mounted under
 * `/v1/ai-knowledge-hub/structure/*` (report §4). It groups every
 * structure-management endpoint in one place:
 *   - BE-01 (2026-06-13) — the ZERO-WRITE `GET /structure` aggregator.
 *   - BE-02 (2026-06-13) — Class-A Phase-1 mutations: domain display-
 *     overlay PATCH (topic i) + coverage-gap CRUD (topic ii).
 *   - BE-03 (Phase 2, 2026-06-13) — Class-A catalog table / column /
 *     relation CRUD (topics iii + iv) + the idempotent seed-from-entity
 *     import (Q-02). All carry the ABSOLUTE no-DDL guarantee: the catalog
 *     is DOCUMENTATION; `tableName` / `columnName` are plain text and
 *     never feed any DDL (DOCS-01 §17.16.3 / report §6.3).
 *   - BE-04 (Phase 3, 2026-06-13) — Class-B tool↔domain binding override
 *     (topic v): `GET /structure/tool-bindings` (admin + super-admin read,
 *     diagnostics) + `PUT /structure/tool-bindings/:domainKey`
 *     (SUPER-ADMIN ONLY, Q-04 — stricter than Class A). Every PUT
 *     re-asserts the registry⇄domain BIJECTION at RUNTIME before commit;
 *     super-admin cannot persist a violating binding (§17.11 — integrity
 *     ≠ permission). The compile-time `derived-domain-map.spec.ts`
 *     validates the CODE fallback; the runtime guard validates the
 *     OVERRIDE — both binding sources are covered.
 *
 * CLAUDE.md references:
 *   - §18.13 — `GET /structure` is a zero-write read aggregator with a
 *     declared authority gate; it never writes a row.
 *   - §17.15.6 / Q-06 LOCKED — (2026-06-16: the read audience, formerly
 *     full EXEC_READ + `workStatus = approved` mirroring `GET /map`, was
 *     narrowed to super-admin only per user direction; supersedes the
 *     prior EXEC_READ / ADMIN_OR_ABOVE audience.)
 *   - §17.16.7 / Q-03 LOCKED — (2026-06-16: Class-A mutations, formerly
 *     admin + super-admin, were narrowed to super-admin only
 *     (`@Roles(...SUPER_ADMIN_ONLY)`) per user direction; supersedes the
 *     prior EXEC_READ / ADMIN_OR_ABOVE audience.) The guard chain is the
 *     only gate.
 *   - §17.2 — every payload is advisory editor display/seed data;
 *     nothing here gates any workflow transition.
 *   - §17.3 — BE-02 mutations audit via `ai_knowledge_audit_logs` ONLY
 *     (`KnowledgeStructureService` → `KnowledgeAuditService`); NEVER
 *     TrackingStatus.
 *   - §17.8 — NON-AI surface: no quota guard, no cooldown guard, no
 *     §17.8 endpoint key (mirrors the `GET /map` carve-out).
 *   - §17.11 — no role exemption; no super-admin bypass path. The Q-05
 *     "derived domains are display-only" rule is integrity, not
 *     permission — re-asserted in the service.
 *
 * Guard chain (mirrors `AiKnowledgeHubController` — cheap token-claim
 * role check BEFORE the live workStatus DB read):
 *   JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard
 */
@Controller({
  path: 'ai-knowledge-hub/structure',
  version: '1',
})
export class KnowledgeStructureController {
  constructor(
    private readonly knowledgeHubService: AiKnowledgeHubService,
    private readonly knowledgeStructureService: KnowledgeStructureService,
    /** BE-03 — Phase-2 catalog / relation CRUD + seed (no-DDL). */
    private readonly knowledgeCatalogService: KnowledgeCatalogService,
    /** BE-04 — Phase-3 Class-B tool-binding override + runtime bijection. */
    private readonly knowledgeToolBindingService: KnowledgeToolBindingService,
  ) {}

  /**
   * GET /v1/ai-knowledge-hub/structure
   *
   * The single editor dataset for FE-01 / FE-02: code descriptors merged
   * with the `ai_knowledge_domain_meta` overlay (incl. hidden nodes for
   * the editor) + the documentation catalog (tables / columns / relations)
   * + the read-only executive tool registry + the `unmappedTools[]`
   * orphan detector. ZERO writes (§18.13 condition 2). No PII, no staging
   * content, no secrets.
   *
   * (2026-06-16: narrowed to super-admin only per user direction;
   * supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience.)
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async getStructure(): Promise<KnowledgeStructureResponseDto> {
    return this.knowledgeHubService.getStructure();
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-02 — Class-A domain display-overlay PATCH (topic i)
  // ──────────────────────────────────────────────────────────────────

  /**
   * PATCH /v1/ai-knowledge-hub/structure/domains/order
   *
   * Bulk drag-reorder convenience (task §3): stamps each key's
   * `display_order` to its array index in one transaction + writes ONE
   * batch `domain_meta_update` audit row. Unknown keys are ignored
   * (task §8). Super-admin only (2026-06-16: narrowed to super-admin
   * only per user direction; supersedes the prior EXEC_READ /
   * ADMIN_OR_ABOVE audience).
   *
   * Declared BEFORE the `:domainKey` route so `order` is not captured as
   * a domain key by the parameterised PATCH below.
   */
  @Patch('domains/order')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async reorderDomains(
    @Body() dto: ReorderKnowledgeDomainsDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeReorderResultDto> {
    return this.knowledgeStructureService.reorderDomains(dto, req.user.userId);
  }

  /**
   * PATCH /v1/ai-knowledge-hub/structure/domains/:domainKey
   *
   * Upsert the Class-A DISPLAY overlay (label TH/EN, description, order,
   * colour, icon, hidden) for a code-declared domain (super-admin only;
   * 2026-06-16: narrowed to super-admin only per user direction;
   * supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience). REJECTS an
   * unknown `domainKey` (`400 KNOWLEDGE_DOMAIN_UNKNOWN`) and an
   * off-allow-list colour/icon (`400 KNOWLEDGE_TOKEN_INVALID`). Q-05 —
   * `key` / `layer` / tool binding are NOT in the DTO, so they cannot be
   * sent. Audits exactly one `domain_meta_update` row.
   */
  @Patch('domains/:domainKey')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async patchDomainOverlay(
    @Param('domainKey') domainKey: string,
    @Body() dto: PatchKnowledgeDomainDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeDomainOverlayDto> {
    return this.knowledgeStructureService.patchDomainOverlay(
      domainKey,
      dto,
      req.user.userId,
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-02 — coverage-gap CRUD (topic ii)
  // ──────────────────────────────────────────────────────────────────

  /**
   * POST /v1/ai-knowledge-hub/structure/gaps
   *
   * Create a UI coverage-gap node (super-admin only; 2026-06-16:
   * narrowed to super-admin only per user direction; supersedes the
   * prior EXEC_READ / ADMIN_OR_ABOVE audience). REJECTS a key colliding
   * with a code domain/gap key or an existing overlay row
   * (`400 KNOWLEDGE_GAP_KEY_COLLISION`). Audits `gap_create`.
   */
  @Post('gaps')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async createGap(
    @Body() dto: CreateKnowledgeGapDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeGapDto> {
    return this.knowledgeStructureService.createGap(dto, req.user.userId);
  }

  /**
   * PATCH /v1/ai-knowledge-hub/structure/gaps/:domainKey
   *
   * Edit a coverage gap's label / reason / order / hidden (super-admin
   * only; 2026-06-16: narrowed to super-admin only per user direction;
   * supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience). A code gap
   * with no overlay yet is UPSERTED; a non-existent non-code key →
   * `404 KNOWLEDGE_GAP_NOT_FOUND`. Audits `gap_update`.
   */
  @Patch('gaps/:domainKey')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async patchGap(
    @Param('domainKey') domainKey: string,
    @Body() dto: PatchKnowledgeGapDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeGapDto> {
    return this.knowledgeStructureService.patchGap(
      domainKey,
      dto,
      req.user.userId,
    );
  }

  /**
   * DELETE /v1/ai-knowledge-hub/structure/gaps/:domainKey
   *
   * Remove a coverage gap (super-admin only; 2026-06-16: narrowed to
   * super-admin only per user direction; supersedes the prior EXEC_READ
   * / ADMIN_OR_ABOVE audience). A UI-created gap is soft-deleted; a CODE
   * gap (e.g. `equipment`) cannot be hard-removed and is HIDDEN instead
   * (`is_hidden = true`) — the response surfaces the nuance. Audits
   * `gap_delete`.
   */
  @Delete('gaps/:domainKey')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async deleteGap(
    @Param('domainKey') domainKey: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeGapDeleteResultDto> {
    return this.knowledgeStructureService.deleteGap(
      domainKey,
      req.user.userId,
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-03 — catalog table CRUD (topic iii)
  // ──────────────────────────────────────────────────────────────────

  /**
   * POST /v1/ai-knowledge-hub/structure/catalog/tables
   *
   * Create a catalog table DOCUMENTATION row (super-admin only;
   * 2026-06-16: narrowed to super-admin only per user direction;
   * supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience).
   * `tableName` is plain text — NEVER an SQL identifier, NEVER feeds DDL
   * (no-DDL guarantee). A duplicate live name →
   * `409 CATALOG_TABLE_NAME_DUPLICATE`. Audits `catalog_table_create`.
   */
  @Post('catalog/tables')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async createCatalogTable(
    @Body() dto: CreateCatalogTableDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<CatalogTableDto> {
    return this.knowledgeCatalogService.createTable(dto, req.user.userId);
  }

  /**
   * PATCH /v1/ai-knowledge-hub/structure/catalog/tables/:id
   *
   * Edit a catalog table's display fields (super-admin only; 2026-06-16:
   * narrowed to super-admin only per user direction; supersedes the
   * prior EXEC_READ / ADMIN_OR_ABOVE audience). A non-existent /
   * soft-deleted id → `404 CATALOG_TABLE_NOT_FOUND`; a rename collision →
   * `409 CATALOG_TABLE_NAME_DUPLICATE`. Audits `catalog_table_update`.
   */
  @Patch('catalog/tables/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async updateCatalogTable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogTableDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<CatalogTableDto> {
    return this.knowledgeCatalogService.updateTable(id, dto, req.user.userId);
  }

  /**
   * DELETE /v1/ai-knowledge-hub/structure/catalog/tables/:id
   *
   * Soft-delete a catalog table (super-admin only; 2026-06-16: narrowed
   * to super-admin only per user direction; supersedes the prior
   * EXEC_READ / ADMIN_OR_ABOVE audience). The service cascades the
   * soft-delete to the table's columns + every dangling relation (NOT a
   * DB CASCADE that hard-deletes) so the ER view stays consistent. Audits
   * `catalog_table_delete`.
   */
  @Delete('catalog/tables/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async deleteCatalogTable(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<CatalogTableDeleteResultDto> {
    return this.knowledgeCatalogService.deleteTable(id, req.user.userId);
  }

  /**
   * PUT /v1/ai-knowledge-hub/structure/catalog/tables/:id/columns
   *
   * Bulk replace the column set for a table (super-admin only;
   * 2026-06-16: narrowed to super-admin only per user direction;
   * supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience): the
   * service diffs the incoming ordered array against the live columns,
   * soft-deletes removed, upserts kept / added. `columnName` / `dataType`
   * are plain text (no-DDL). Audits ONE batch `catalog_column_upsert` row.
   */
  @Put('catalog/tables/:id/columns')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async upsertCatalogColumns(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertCatalogColumnsDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<CatalogColumnUpsertResultDto> {
    return this.knowledgeCatalogService.upsertColumns(id, dto, req.user.userId);
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-03 — relationship (ER) CRUD (topic iv)
  // ──────────────────────────────────────────────────────────────────

  /**
   * POST /v1/ai-knowledge-hub/structure/catalog/relations
   *
   * Draw an ER edge between two catalog tables (super-admin only;
   * 2026-06-16: narrowed to super-admin only per user direction;
   * supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience). Both ids
   * must reference LIVE catalog tables
   * (`400 CATALOG_RELATION_TABLE_INVALID`); a self-loop without `allowSelf`
   * → `400 CATALOG_RELATION_SELF_LOOP`; `relationType` is required. The
   * edge is DOCUMENTATION — `onDeleteNote` is never enforced at the DB
   * (no-DDL). Audits `relation_create`.
   */
  @Post('catalog/relations')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async createCatalogRelation(
    @Body() dto: CreateCatalogRelationDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<CatalogRelationDto> {
    return this.knowledgeCatalogService.createRelation(dto, req.user.userId);
  }

  /**
   * PATCH /v1/ai-knowledge-hub/structure/catalog/relations/:id
   *
   * Edit an ER edge's type / label / note / order (super-admin only;
   * 2026-06-16: narrowed to super-admin only per user direction;
   * supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience). A
   * non-existent / soft-deleted id → `404 CATALOG_RELATION_NOT_FOUND`.
   * The table ids cannot be re-pointed (the DTO omits them). Audits
   * `relation_update`.
   */
  @Patch('catalog/relations/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async updateCatalogRelation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogRelationDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<CatalogRelationDto> {
    return this.knowledgeCatalogService.updateRelation(
      id,
      dto,
      req.user.userId,
    );
  }

  /**
   * DELETE /v1/ai-knowledge-hub/structure/catalog/relations/:id
   *
   * Soft-delete an ER edge (super-admin only; 2026-06-16: narrowed to
   * super-admin only per user direction; supersedes the prior EXEC_READ
   * / ADMIN_OR_ABOVE audience). A non-existent / already-deleted id →
   * `404 CATALOG_RELATION_NOT_FOUND`. Audits `relation_delete`.
   */
  @Delete('catalog/relations/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async deleteCatalogRelation(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<CatalogRelationDeleteResultDto> {
    return this.knowledgeCatalogService.deleteRelation(id, req.user.userId);
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-03 — seed-from-entity import (Q-02)
  // ──────────────────────────────────────────────────────────────────

  /**
   * POST /v1/ai-knowledge-hub/structure/catalog/seed
   *
   * One-shot, idempotent import (Q-02, super-admin only; 2026-06-16:
   * narrowed to super-admin only per user direction; supersedes the
   * prior EXEC_READ / ADMIN_OR_ABOVE audience). Reads TypeORM
   * `DataSource.entityMetadatas` READ-ONLY and inserts catalog tables /
   * columns as DATA rows (`is_seeded = true`) for any table not already
   * present as a LIVE catalog row. It issues NO DDL, touches NO schema, and
   * NEVER round-trips to alter anything. Skips existing `(table_name)` rows
   * so a second run inserts zero duplicates and never clobbers an admin's
   * hand edits. Audits one batch `catalog_table_create` row.
   */
  @Post('catalog/seed')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async seedCatalog(
    @Req() req: { user: JwtPayloadUser },
  ): Promise<CatalogSeedResultDto> {
    return this.knowledgeCatalogService.seedFromEntities(req.user.userId);
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-04 — Class-B tool↔domain binding override (topic v, Phase 3)
  // ──────────────────────────────────────────────────────────────────

  /**
   * GET /v1/ai-knowledge-hub/structure/tool-bindings
   *
   * Read the RESOLVED binding per derived domain (override set when the
   * `ai_knowledge_tool_binding` table has rows, else the code fallback) +
   * the full read-only registry pick-list + `unmappedTools[]` /
   * `doubleMappedTools[]` diagnostics. Super-admin read (2026-06-16:
   * narrowed to super-admin only per user direction; supersedes the
   * prior EXEC_READ / ADMIN_OR_ABOVE audience — the WRITE was already
   * super-admin only). ZERO-WRITE (§18.13 condition 2).
   */
  @Get('tool-bindings')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async getToolBindings(): Promise<ToolBindingReadDto> {
    return this.knowledgeToolBindingService.getToolBindings();
  }

  /**
   * PUT /v1/ai-knowledge-hub/structure/tool-bindings/:domainKey
   *
   * Replace the override tool set for ONE derived domain. SUPER-ADMIN
   * ONLY (Q-04 — `@Roles(...SUPER_ADMIN_ONLY)`). (2026-06-16: the rest of
   * the hub was also narrowed to super-admin only per user direction;
   * the prior "stricter than the Class-A ADMIN_OR_ABOVE" distinction no
   * longer applies — every gate is now SUPER_ADMIN_ONLY.) The body
   * carries the FULL desired
   * `toolName[]` (replace-set). The service re-asserts the registry⇄domain
   * BIJECTION at RUNTIME inside the transaction — unknown tool / orphan /
   * double-map → `400 KNOWLEDGE_TOOL_BINDING_INVALID` and a full rollback;
   * a non-derived `:domainKey` is rejected the same way. There is NO
   * super-admin bypass — the guard is integrity, not permission (§17.11).
   * Audits exactly one `tool_binding_update` row.
   */
  @Put('tool-bindings/:domainKey')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async putToolBinding(
    @Param('domainKey') domainKey: string,
    @Body() dto: PutToolBindingDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<ToolBindingWriteResultDto> {
    return this.knowledgeToolBindingService.putToolBinding(
      domainKey,
      dto,
      req.user.userId,
    );
  }
}
