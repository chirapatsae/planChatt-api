import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AiKnowledgeEntry } from '../entities/ai-knowledge-entry.entity';
import { ALL_KNOWLEDGE_DOMAIN_KEYS } from '../registry/derived-domain-map';

/** Hard top-k ceiling per BE-04 (report §7.2 token-bloat mitigation). */
export const KNOWLEDGE_SEARCH_MAX_RESULTS = 5;
/** Default top-k when the caller omits `limit`. */
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 3;
/** Hard excerpt cap in characters (BE-04 §3 — token-bloat mitigation). */
export const KNOWLEDGE_SEARCH_EXCERPT_MAX_CHARS = 800;
/** Hard query-length cap; longer input is truncated, never rejected. */
export const KNOWLEDGE_SEARCH_QUERY_MAX_CHARS = 200;

/**
 * pg_trgm similarity floor for the recall arm of the match predicate.
 * Deliberately low — Thai content yields low trigram scores on short
 * queries (Q5 risk note); the ILIKE arms + tag/domain boost carry the
 * precision while this floor adds fuzzy recall.
 */
const TRGM_SIMILARITY_FLOOR = 0.05;

/** One search hit — the exact item shape of the tool `returnSchema`. */
export interface KnowledgeSearchItem {
  entryId: string;
  title: string;
  /** Trimmed body excerpt, hard-capped at 800 chars. */
  excerpt: string;
  domainKey: string;
  origin: 'curated' | 'external';
  /** Source name for `origin='external'` rows; null for curated. */
  sourceName: string | null;
  /** ISO timestamp — provenance for the "cite ที่มา" prompt rule. */
  updatedAt: string;
  version: number;
}

export interface KnowledgeSearchResult {
  items: KnowledgeSearchItem[];
  asOf: string;
}

export interface KnowledgeSearchParams {
  query: string;
  /** Optional domain boost key — soft RANK boost, NOT a hard filter. */
  domainKey?: string;
  /** Top-k (1..5); clamped server-side, default 3. */
  limit?: number;
}

/**
 * Diagnostic options for the admin "retrieval test" surface ONLY
 * (`POST /v1/ai-knowledge-hub/search-preview`, AiKnowledgeHubService.
 * searchPreview). They MUST NOT be passed by the chat tool path.
 */
export interface KnowledgeSearchOptions {
  /**
   * Override the {@link KNOWLEDGE_SEARCH_MAX_RESULTS} top-k ceiling for
   * the preview/diagnostic path so the SAME ranking SQL can surface the
   * full ranked candidate set (up to this value) and the preview can
   * compute a 1-based `targetRank`. NEVER set on the tool path — the AI
   * tool stays capped at {@link KNOWLEDGE_SEARCH_MAX_RESULTS}.
   *
   * The published-only + soft-delete predicates are baked into the ONE
   * ranking implementation and apply IDENTICALLY regardless of this
   * override — it widens the row window, it does NOT relax visibility.
   */
  maxResultsOverride?: number;
}

/** Hard ceiling for the diagnostic preview window (BE — retrieval test). */
export const KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS = 20;

/** Raw projection row returned by the search query builder. */
interface KnowledgeSearchRawRow {
  entryId: string;
  title: string;
  bodyMd: string;
  domainKey: string;
  origin: 'curated' | 'external';
  version: number | string;
  updatedAt: Date | string;
  sourceName: string | null;
}

/**
 * Wave wave-ai-knowledge-hub — BE-04 (2026-06-12).
 *
 * KnowledgeSearchService — the SINGLE retrieval backend of the
 * `searchKnowledgeBase` executive tool (report §2.4: tool-based
 * retrieval; NO RAG context-stuffing; pgvector is a Phase-B internal
 * upgrade behind this same contract).
 *
 * CLAUDE.md references:
 *   - §17.15.4 — ONLY `status = 'published'` entries are prompt-eligible.
 *     Draft / archived rows and ANY staging payload NEVER leave this
 *     query. The status + soft-delete predicates are baked into the
 *     query itself (not post-filtered) and are spec-asserted in
 *     `__tests__/knowledge-search.spec.ts`.
 *   - §17.9 — delimiter wrapping happens at CONSUMPTION time inside the
 *     chat tool loop (`wrapToolResult`), NOT here. `body_md` is hostile
 *     by default; this service returns raw excerpts and relies on the
 *     existing wrap + schema validation.
 *   - §17.2 — results are advisory retrieval data; they gate nothing.
 *   - §17.8 — the consuming tool rides the EXISTING `executive-chat`
 *     cooldown/quota keys; this service registers NO new key.
 *   - §18.13 discipline — ZERO-WRITE: one read query per call, no
 *     repository mutation, no audit row, no notification.
 *
 * Retrieval (Q5 LOCKED = pg_trgm, Thai-dominant corpus): the match
 * predicate combines ILIKE needles over title / body / tags with a
 * low-floor `similarity()` recall arm (backed by the DB-01 GIN trgm
 * indexes). Ranking = max trgm similarity + exact-ish tag-match boost
 * + domain-match boost (the BE-04 "tag/domain boost" answer to the
 * short-Thai-query recall risk).
 */
@Injectable()
export class KnowledgeSearchService {
  constructor(
    @InjectRepository(AiKnowledgeEntry)
    private readonly entryRepository: Repository<AiKnowledgeEntry>,
  ) {}

  /**
   * Published-only top-k retrieval. Never throws on degenerate input:
   * an empty/whitespace query short-circuits to zero items WITHOUT
   * touching the database (the tool loop treats every thrown error as a
   * 500 `TOOL_EXECUTION_FAILED`, so degenerate LLM input degrades to an
   * empty result the model can recover from instead).
   */
  async search(
    params: KnowledgeSearchParams,
    opts?: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchResult> {
    const query = (params.query ?? '')
      .normalize('NFC')
      .trim()
      .slice(0, KNOWLEDGE_SEARCH_QUERY_MAX_CHARS);
    if (query.length === 0) {
      return { items: [], asOf: new Date().toISOString() };
    }

    // Diagnostic preview path widens the row window via
    // `maxResultsOverride` (clamped to KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS).
    // The tool path passes no opts → the KNOWLEDGE_SEARCH_MAX_RESULTS cap
    // (5) holds. Either way the published-only + soft-delete predicates
    // below are unchanged — the override only changes the LIMIT.
    const limit = this.clampLimit(params.limit, opts?.maxResultsOverride);
    // Unknown domain keys are ignored (no boost) — the tool paramsSchema
    // already enum-gates this on the chat path; this is belt-and-braces
    // for direct service callers. '' matches no row's domain_key.
    const boostDomainKey =
      params.domainKey && ALL_KNOWLEDGE_DOMAIN_KEYS.includes(params.domainKey)
        ? params.domainKey
        : '';

    // LIKE metacharacters escaped so user input is always a literal
    // needle (same convention as `AiKnowledgeHubService.listEntries`).
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;

    const rows = await this.entryRepository
      .createQueryBuilder('entry')
      .leftJoin('entry.source', 'source')
      .select('entry.id', 'entryId')
      .addSelect('entry.title', 'title')
      .addSelect('entry.bodyMd', 'bodyMd')
      .addSelect('entry.domainKey', 'domainKey')
      .addSelect('entry.origin', 'origin')
      .addSelect('entry.currentVersion', 'version')
      .addSelect('entry.updatedAt', 'updatedAt')
      .addSelect('source.name', 'sourceName')
      // Rank: max trgm similarity over title/body + tag-match boost +
      // domain-match boost (Q5 — short Thai queries score low on
      // trigrams alone, so exact-ish matches must dominate).
      .addSelect(
        'GREATEST(similarity(entry.title, :query), similarity(entry.bodyMd, :query))' +
          ' + (CASE WHEN EXISTS (SELECT 1 FROM unnest(entry.tags) AS tag WHERE tag ILIKE :pattern) THEN 0.5 ELSE 0 END)' +
          ' + (CASE WHEN entry.domainKey = :boostDomainKey THEN 0.25 ELSE 0 END)',
        'score',
      )
      // §17.15.4 exposure invariant — published-only, non-deleted. These
      // two predicates are the BE-04 acceptance-critical lines: draft /
      // archived / soft-deleted rows can NEVER be selected.
      .where('entry.status = :published', { published: 'published' })
      .andWhere('entry.deletedAt IS NULL')
      .andWhere(
        '(entry.title ILIKE :pattern' +
          ' OR entry.bodyMd ILIKE :pattern' +
          ' OR EXISTS (SELECT 1 FROM unnest(entry.tags) AS tag WHERE tag ILIKE :pattern)' +
          ' OR similarity(entry.title, :query) >= :simFloor' +
          ' OR similarity(entry.bodyMd, :query) >= :simFloor)',
        { pattern, query, simFloor: TRGM_SIMILARITY_FLOOR },
      )
      .setParameter('boostDomainKey', boostDomainKey)
      .orderBy('score', 'DESC')
      .addOrderBy('entry.updatedAt', 'DESC')
      .limit(limit)
      .getRawMany<KnowledgeSearchRawRow>();

    return {
      items: rows.map((row) => this.toSearchItem(row, query)),
      asOf: new Date().toISOString(),
    };
  }

  private clampLimit(
    limit: number | undefined,
    maxResultsOverride?: number,
  ): number {
    // The diagnostic preview path raises the ceiling (cap-of-the-cap is
    // KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS); the tool path stays at
    // KNOWLEDGE_SEARCH_MAX_RESULTS. A garbage override falls back to the
    // tool ceiling so the override can NEVER leak an unbounded LIMIT.
    const ceiling =
      typeof maxResultsOverride === 'number' &&
      Number.isFinite(maxResultsOverride)
        ? Math.min(
            Math.max(Math.trunc(maxResultsOverride), 1),
            KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS,
          )
        : KNOWLEDGE_SEARCH_MAX_RESULTS;

    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      return Math.min(KNOWLEDGE_SEARCH_DEFAULT_LIMIT, ceiling);
    }
    return Math.min(Math.max(Math.trunc(limit), 1), ceiling);
  }

  /**
   * Strict projection — only the eight `returnSchema` item keys leave
   * this method (no contentHash, no actor WorkHistory uuids, no
   * classification internals).
   */
  private toSearchItem(
    row: KnowledgeSearchRawRow,
    query: string,
  ): KnowledgeSearchItem {
    return {
      entryId: row.entryId,
      title: row.title,
      excerpt: this.buildExcerpt(row.bodyMd ?? '', query),
      domainKey: row.domainKey,
      origin: row.origin,
      sourceName: row.sourceName ?? null,
      updatedAt:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : new Date(row.updatedAt).toISOString(),
      version: Number(row.version) || 1,
    };
  }

  /**
   * Body excerpt, hard-capped at {@link KNOWLEDGE_SEARCH_EXCERPT_MAX_CHARS}
   * INCLUDING the ellipsis chars. When the first query match sits deep
   * in the body, the window is re-centered so the hit is visible.
   */
  private buildExcerpt(bodyMd: string, query: string): string {
    const body = bodyMd.normalize('NFC');
    const max = KNOWLEDGE_SEARCH_EXCERPT_MAX_CHARS;
    if (body.length <= max) {
      return body;
    }

    const matchIndex = body.toLowerCase().indexOf(query.toLowerCase());
    // Re-center only when the hit would fall outside a from-start window.
    const start =
      matchIndex > max - 100
        ? Math.min(Math.max(matchIndex - 100, 0), body.length - 1)
        : 0;

    const prefix = start > 0 ? '…' : '';
    const sliceLen = max - prefix.length - 1; // reserve 1 char for tail '…'
    const slice = body.slice(start, start + sliceLen);
    const suffix = start + sliceLen < body.length ? '…' : '';
    return `${prefix}${slice}${suffix}`;
  }
}
