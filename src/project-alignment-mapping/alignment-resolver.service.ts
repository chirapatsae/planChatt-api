import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProjectAlignmentMapping } from './entities/project-alignment-mapping.entity';
import {
  AlignmentRow,
  AlignmentTriple,
  TripleKey,
  buildTripleKey,
} from './types/alignment.types';
import { projectDimension } from './internal/project-dimension.helper';

/**
 * AlignmentResolverService — BATCHED read-only resolver.
 *
 * Companion to `ProjectAlignmentMappingService.lookup()` (single-row,
 * 404-on-miss). This service is built for PDF renderers that need to
 * resolve 50-150 distinct triples per book in one shot.
 *
 * Contract:
 *  - `resolveMany(triples)` returns a Map keyed by `${strategyId}||${tacticId}||${planId}`.
 *  - Triples NOT in the alignment table are simply ABSENT from the map
 *    (caller uses `map.get(key) ?? null`). No throw on miss — a PDF
 *    book may legitimately contain projects that have not yet been
 *    mapped, and we do NOT want to fail the whole render.
 *  - Empty input → empty Map, no SQL.
 *  - Duplicate input triples are de-duplicated before the query.
 *
 * §12 — config rows; NO TrackingStatus interaction.
 * §4.1 — read-only; no ownership / role gate (callers must apply their
 *        own auth before invoking).
 * §17.3 — alignment masters have no FK to project tables; this query
 *        never touches the workflow audit trail.
 * §20 — parity: this resolver is the SINGLE projection consumed by all
 *        4 PDF subsystems (MAIN / EDIT / CHANGE / SUPPLEMENT), so the
 *        Wave multi-national-strategy-per-alignment array expansion
 *        lands uniformly with no per-subsystem branch.
 *
 * --- Multi-value secondaries (Wave multi-national-strategy-per-alignment) ---
 *
 * Three dimensions (NS / SDG / PS) are now multi-valued via sibling
 * junction entities. The resolver eager-loads the 3 junctions and
 * projects each dimension as a primary-first array. The legacy scalar
 * fields on `AlignmentRow` are retained for backward compatibility
 * (set to `arrays[0]`) and are @deprecated — see
 * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
 * §Scalar-FK Deprecation Contract.
 */
@Injectable()
export class AlignmentResolverService {
  private readonly logger = new Logger(AlignmentResolverService.name);

  constructor(
    @InjectRepository(ProjectAlignmentMapping)
    private readonly repo: Repository<ProjectAlignmentMapping>,
  ) {}

  /**
   * Single-triple convenience wrapper. Returns `null` (NOT 404) when
   * the triple has no mapping — this is the difference from
   * `ProjectAlignmentMappingService.lookup()`.
   */
  async resolveOne(triple: AlignmentTriple): Promise<AlignmentRow | null> {
    const map = await this.resolveMany([triple]);
    return map.get(buildTripleKey(triple)) ?? null;
  }

  /**
   * Batched resolve.
   *
   * SQL strategy: row-value IN clause against the unique triple key.
   * Postgres compiles `(strategy_id, tactic_id, plan_id) IN ((a,b,c),
   * (d,e,f), ...)` to a single index probe over the UQ_project_alignment_triple
   * unique index, which is far cheaper than 150 round-trips.
   *
   * We use the QueryBuilder rather than `repo.find({ where: [...] })`
   * because TypeORM's array-where form generates 150 separate
   * `OR (a=? AND b=? AND c=?)` clauses, which is slower and harder to
   * read in slow-query logs.
   *
   * Eager relations:
   *  - 4 scalar master refs (NS / MS / SDG / PS) for back-compat.
   *  - 3 junctions (NS / SDG / PS) plus their nested master refs for
   *    the array projections shipped by Wave
   *    multi-national-strategy-per-alignment.
   *
   * The 6 added joins (3 junction + 3 nested refs) add cost to the
   * eager query; the resolver is batched by triple (small N), so the
   * cost is acceptable per BE-01 §11. Phase 2 filter endpoints
   * intentionally bypass this resolver per DOCS-02 §7.5 to keep filter
   * performance independent.
   */
  async resolveMany(
    triples: AlignmentTriple[],
  ): Promise<Map<TripleKey, AlignmentRow>> {
    const result = new Map<TripleKey, AlignmentRow>();

    if (!triples || triples.length === 0) {
      return result;
    }

    // Defensive dedup — callers (PDF assemblers) may pass duplicates
    // when many projects share the same classification triple.
    const dedup = new Map<TripleKey, AlignmentTriple>();
    for (const t of triples) {
      if (!t || !t.strategyId || !t.tacticId || !t.planId) {
        // Skip malformed entries silently — the map miss serves as the
        // signal to the caller. Logging only at debug to avoid noise.
        this.logger.debug(
          `resolveMany: skipping malformed triple ${JSON.stringify(t)}`,
        );
        continue;
      }
      dedup.set(buildTripleKey(t), {
        strategyId: t.strategyId,
        tacticId: t.tacticId,
        planId: t.planId,
      });
    }

    if (dedup.size === 0) {
      return result;
    }

    const uniqueTriples = Array.from(dedup.values());

    // Build row-value IN clause. TypeORM does not have a first-class
    // helper for row-value IN, so we assemble parameterized placeholders
    // by hand. Each triple contributes 3 parameters.
    const placeholders: string[] = [];
    const params: Record<string, string> = {};
    uniqueTriples.forEach((t, idx) => {
      const sKey = `s_${idx}`;
      const tKey = `t_${idx}`;
      const pKey = `p_${idx}`;
      placeholders.push(`(:${sKey}, :${tKey}, :${pKey})`);
      params[sKey] = t.strategyId;
      params[tKey] = t.tacticId;
      params[pKey] = t.planId;
    });

    const rows = await this.repo
      .createQueryBuilder('pam')
      .leftJoinAndSelect('pam.nationalStrategy', 'ns')
      .leftJoinAndSelect('pam.milestone', 'ms')
      .leftJoinAndSelect('pam.sdg', 'sd')
      .leftJoinAndSelect('pam.provinceStrategy', 'ps')
      // 3 junction expansions (uniform pattern) — Wave
      // multi-national-strategy-per-alignment.
      .leftJoinAndSelect('pam.nationalStrategies', 'pamNs')
      .leftJoinAndSelect('pamNs.nationalStrategy', 'pamNsRef')
      .leftJoinAndSelect('pam.sdgs', 'pamSdg')
      .leftJoinAndSelect('pamSdg.sdg', 'pamSdgRef')
      .leftJoinAndSelect('pam.provinceStrategies', 'pamPs')
      .leftJoinAndSelect('pamPs.provinceStrategy', 'pamPsRef')
      .where(
        `(pam.strategy_id, pam.tactic_id, pam.plan_id) IN (${placeholders.join(', ')})`,
        params,
      )
      .getMany();

    for (const row of rows) {
      // Defensive: a master row could theoretically be null if a future
      // schema change loosens the FK. Current schema forbids null, so
      // these guards are belt-and-braces.
      if (
        !row.nationalStrategy ||
        !row.milestone ||
        !row.sdg ||
        !row.provinceStrategy
      ) {
        this.logger.warn(
          `resolveMany: alignment row ${row.id} has missing master ref(s); skipping`,
        );
        continue;
      }

      const key = buildTripleKey({
        strategyId: row.strategyId,
        tacticId: row.tacticId,
        planId: row.planId,
      });

      // Build the 3 dimension arrays — primary scalar first, junction
      // secondaries sorted by sortOrder ASC, deduped by id. The scalar
      // back-compat field is set to arrays[0] (Scalar-FK Deprecation
      // Contract — README §3 sort order, §1 status).
      const nationalStrategies = projectDimension(
        row.nationalStrategy,
        row.nationalStrategies,
        'nationalStrategy',
      );
      const sdgs = projectDimension(row.sdg, row.sdgs, 'sdg');
      const provinceStrategies = projectDimension(
        row.provinceStrategy,
        row.provinceStrategies,
        'provinceStrategy',
      );

      result.set(key, {
        // Back-compat scalars — equal to arrays[0]. @deprecated; new
        // code MUST read the array fields instead.
        nationalStrategy: nationalStrategies[0],
        sdg: sdgs[0],
        provinceStrategy: provinceStrategies[0],
        // Source-of-truth arrays.
        nationalStrategies,
        sdgs,
        provinceStrategies,
        // Milestone — stays scalar (single-valued by domain).
        milestone: {
          id: row.milestone.id,
          code: row.milestone.code ?? null,
          nameTh: row.milestone.nameTh,
        },
      });
    }

    return result;
  }
}
