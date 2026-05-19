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
   * Eager relations are loaded for the four master refs so the
   * downstream projection requires zero extra SQL.
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

      result.set(key, {
        nationalStrategy: {
          id: row.nationalStrategy.id,
          code: row.nationalStrategy.code ?? null,
          nameTh: row.nationalStrategy.nameTh,
        },
        milestone: {
          id: row.milestone.id,
          code: row.milestone.code ?? null,
          nameTh: row.milestone.nameTh,
        },
        sdg: {
          id: row.sdg.id,
          code: row.sdg.code ?? null,
          nameTh: row.sdg.nameTh,
        },
        provinceStrategy: {
          id: row.provinceStrategy.id,
          code: row.provinceStrategy.code ?? null,
          nameTh: row.provinceStrategy.nameTh,
        },
      });
    }

    return result;
  }
}
