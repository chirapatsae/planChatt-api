import { KnowledgeDomainLayer } from '../registry/derived-domain-map';

/**
 * Wave wave-ai-knowledge-hub — BE-01 (2026-06-12).
 *
 * Response shapes for `GET /v1/ai-knowledge-hub/map` — the single data
 * source for the FE-01 mind-map (`/executive/knowledge-map`). Plain
 * interface shapes (not `class-validator` classes) per the
 * `ai-executive-chat/dto/conversation.dto.ts` precedent — response
 * envelopes only; the endpoint takes no body.
 *
 * §17.3 boundary — no field here references a project / plan /
 * tracking row; the payload is counts + code-declared metadata only.
 * §17.15.6 — NO PII, NO staging content, NO secrets in this payload.
 * §17.2 — advisory display data; FE MUST NOT derive domains
 * client-side (it relies on this DTO, mirroring the §14.10 philosophy).
 */

/** Registry tool metadata projected for the node detail panel. */
export interface KnowledgeMapToolDto {
  name: string;
  thaiLabel: string;
  description: string;
}

export interface KnowledgeMapCuratedCountsDto {
  published: number;
  draft: number;
}

export interface KnowledgeMapDomainDto {
  key: string;
  /**
   * Resolved Thai label — `label_th_override` from the overlay when set,
   * else the code descriptor `labelTh` (overlay-not-replacement, BE-01
   * map merge / report §4.2). A missing overlay row falls back to code.
   */
  labelTh: string;
  /** Resolved English label — overlay override ?? code `labelEn`. */
  labelEn: string;
  layer: KnowledgeDomainLayer;
  /** Backing registry tools — empty array for curated-layer domains. */
  tools: KnowledgeMapToolDto[];
  /** Live grouped counts from `ai_knowledge_entries` per `domain_key`. */
  curatedCounts: KnowledgeMapCuratedCountsDto;
  /**
   * Count of registered external sources targeting this domain
   * (`ai_knowledge_sources.target_domain_key`). 0 until Phase 2
   * (BE-03 connector console) registers sources.
   */
  externalSourceCount: number;
  /**
   * ISO-8601 of MAX(`ai_knowledge_entries.updated_at`) per domain;
   * null when the domain has no entries yet. Freshness display only —
   * never an auto-recompute trigger (§17.5).
   */
  lastUpdatedAt: string | null;
  /** Q2 LOCKED — always `['admin', 'super-admin']`. */
  editableBy: string[];
  // ── BE-01 display-overlay fields (`ai_knowledge_domain_meta`) ──────
  // Overlay-not-replacement: each is the overlay value, or the code
  // default (description = null, displayOrder = code order, colorToken /
  // iconKey = null, isHidden = false) when no overlay row exists.
  /** Admin-authored domain description (no code equivalent). NULL = none. */
  description: string | null;
  /** Mind-map ring position; code-declaration order when no overlay row. */
  displayOrder: number;
  /** Design-system colour token (overlay-only). NULL = theme default. */
  colorToken: string | null;
  /** lucide icon key (overlay-only). NULL = FE default per layer. */
  iconKey: string | null;
  /** Hidden from the mind-map render (overlay-only). Default false. */
  isHidden: boolean;
}

export interface KnowledgeCoverageGapDto {
  key: string;
  labelTh: string;
  reason: string;
  // ── BE-01 display-overlay fields (`node_kind = 'gap'`) ────────────
  /** Mind-map ring position; code-declaration order when no overlay row. */
  displayOrder: number;
  /** Hidden from the mind-map render (overlay-only). Default false. */
  isHidden: boolean;
}

export interface KnowledgeMapResponseDto {
  /** Static center-node label (report §3 — mind-map hub). */
  centerLabel: string;
  /** ISO-8601 timestamp the map projection was computed. */
  asOf: string;
  domains: KnowledgeMapDomainDto[];
  /** Q1 — honest coverage-gap nodes (equipment). */
  coverageGaps: KnowledgeCoverageGapDto[];
}
