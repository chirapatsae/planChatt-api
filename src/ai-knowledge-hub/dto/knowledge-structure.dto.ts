import { KnowledgeDomainLayer } from '../registry/derived-domain-map';
import {
  KnowledgeCoverageGapDto,
  KnowledgeMapToolDto,
} from './knowledge-map.dto';

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-01 (2026-06-13).
 *
 * Response shapes for `GET /v1/ai-knowledge-hub/structure` — the single
 * read aggregator the visual editors (FE-01 domain/structure editor,
 * FE-02 catalog + ER builder) consume in ONE round-trip (report §4.3).
 *
 * Plain interface shapes (not `class-validator` classes) per the
 * `knowledge-map.dto.ts` precedent — this is a response envelope only;
 * the endpoint takes no body.
 *
 * Invariants (CLAUDE.md §17.3 / §17.16 / §18.13):
 *   - ZERO-WRITE: this DTO is assembled from grouped SELECTs only; the
 *     aggregator never mutates a row (§18.13 condition 2).
 *   - §17.2 advisory — nothing in this payload gates any workflow; it is
 *     editor display/seed data only.
 *   - §17.16 overlay-not-replacement — `domains[]` is the code descriptor
 *     MERGED with the `ai_knowledge_domain_meta` overlay; `codeOrigin`
 *     marks that the domain's existence + tool binding come from code
 *     (the editor must NOT offer add/delete on a code-origin domain — Q-05).
 *   - No-DDL — `catalog.*` is plain-text DOCUMENTATION; `tableName` /
 *     `columnName` never reach a query builder as identifiers.
 */

/** A single domain node, code descriptor merged with the DB overlay. */
export interface KnowledgeStructureDomainDto {
  key: string;
  /** Resolved labels (overlay override ?? code). */
  labelTh: string;
  labelEn: string;
  /** Code descriptor labels, UNMERGED — so the editor can show "คืนค่าจากระบบ". */
  codeLabelTh: string;
  codeLabelEn: string;
  layer: KnowledgeDomainLayer;
  /** Overlay description (no code equivalent); NULL when unset. */
  description: string | null;
  displayOrder: number;
  colorToken: string | null;
  iconKey: string | null;
  isHidden: boolean;
  /**
   * Existence + tool binding are code-declared (Q-05): the editor may
   * reorder / hide / relabel / recolour but NEVER add or delete a
   * code-origin domain. Always `true` in Phase 1 (every domain node is
   * a `derived-domain-map.ts` descriptor).
   */
  codeOrigin: true;
  /** Read-only backing registry tools — empty for curated-layer domains. */
  tools: KnowledgeMapToolDto[];
  /** Q2 LOCKED — always `['admin', 'super-admin']`. */
  editableBy: string[];
  /**
   * True when an `ai_knowledge_domain_meta` row backs this descriptor;
   * false = pure code fallback (no overlay row yet — pre-seed state). The
   * editor uses this to know whether a PATCH will INSERT or UPDATE.
   */
  hasOverlay: boolean;
}

/** A catalog table card (report §3.3) with its nested columns. */
export interface KnowledgeStructureCatalogColumnDto {
  id: string;
  columnName: string;
  dataType: string | null;
  isNullable: boolean;
  description: string | null;
  isPii: boolean;
  displayOrder: number;
}

export interface KnowledgeStructureCatalogTableDto {
  id: string;
  /** Plain-text documentation name — NOT an SQL identifier (no-DDL). */
  tableName: string;
  displayNameTh: string;
  description: string | null;
  domainKey: string | null;
  isSeeded: boolean;
  displayOrder: number;
  columns: KnowledgeStructureCatalogColumnDto[];
}

/** A drawn ER relationship between two catalog tables (report §3.5). */
export interface KnowledgeStructureCatalogRelationDto {
  id: string;
  fromTableId: string;
  toTableId: string;
  relationType: string;
  labelTh: string | null;
  /** Free-text documentation note — never enforced at the DB (no-DDL). */
  onDeleteNote: string | null;
  displayOrder: number;
}

export interface KnowledgeStructureCatalogDto {
  tables: KnowledgeStructureCatalogTableDto[];
  relations: KnowledgeStructureCatalogRelationDto[];
}

export interface KnowledgeStructureResponseDto {
  /** Static center-node label (mirrors the map). */
  centerLabel: string;
  /** ISO-8601 timestamp the structure projection was computed. */
  asOf: string;
  /** Code descriptors merged with the DB overlay (incl. hidden — editor shows all). */
  domains: KnowledgeStructureDomainDto[];
  /** Coverage gaps (code seed + UI-added `node_kind = 'gap'` rows), merged. */
  gaps: KnowledgeCoverageGapDto[];
  /** Documentation catalog (empty until BE-03 + admin curate). */
  catalog: KnowledgeStructureCatalogDto;
  /**
   * The FULL read-only executive tool registry (every `EXECUTIVE_TOOL_NAMES`
   * entry + Thai label + description) — lets the Phase-3 binding editor
   * (FE-02) pick from a valid list. Read-only here (§17.16.5 bijection;
   * BE-04 owns the override).
   */
  toolRegistry: KnowledgeMapToolDto[];
  /**
   * Registry tools NOT present in any domain's RESOLVED binding — the
   * orphan detector surfaced to the admin. Computed against the CODE map
   * in Phase 1 (BE-01 reads tool binding from code only, per task §4 /
   * §6); empty when the code map is complete (bijection holds).
   */
  unmappedTools: KnowledgeMapToolDto[];
  /**
   * Overlay rows whose `domain_key` no longer exists in code (stale —
   * task §8). The merge IGNORES them (code is the existence source of
   * truth); they are surfaced here so an admin can clean them up. Empty
   * in the healthy case.
   */
  staleOverlayKeys: string[];
}
