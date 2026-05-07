/**
 * Wave 54 — BE-W54-05 — GeoEnrichment concrete service.
 *
 * Implements `IGeoEnrichment` (foundation interface). Annotates a
 * `UnifiedProject[]` batch with Thai amphoe name resolution.
 *
 * Wave 55 W55-BE-04 (2026-04-24) — per-row SPG semantics.
 *
 *   Previously `SupplementProjectGroup` had no `amphoe_id` column, so
 *   this service skipped the entire kind and emitted a BATCH-WIDE
 *   `geo:supplement` missingDimension + Thai advisory.
 *
 *   W55-DB-01 added a nullable `amphoe_id` FK to `supplement_project
 *   _groups` and W55-BE-04 updates the aggregator to project it.
 *   The batch-wide exclusion is replaced by PER-ROW fallback:
 *
 *     - SPG row with populated `amphoeId` → enriched normally via the
 *       same Amphoe-join query path used by PG / RPG.
 *     - SPG row with `amphoeId === null` (historical backfill gap) →
 *       NOT enriched; this service emits `geo:supplement` exactly once
 *       per-run (deduped) and pairs it with the existing Thai advisory
 *       `GEO_SUPPLEMENT_EXCLUDED` from `advisory-copy.ts`.
 *
 *   The advisory token itself is UNCHANGED (§17.9 — advisory constants
 *   are the single source of truth). Only the trigger shifted from
 *   batch-wide to per-row.
 *
 * §17.2 advisory-only — this enrichment NEVER gates a workflow
 * transition. Empty input → empty result, no advisory.
 *
 * §17.11 — no role exemption. Services accept an already-asserted
 * executive context; the role-check gate lives at Tier C.
 *
 * Implementation notes:
 *   - Entity-metadata resolution ONLY. Repositories are fetched through
 *     `dataSource.getRepository(X)`; JOINs against `Amphoe` use the
 *     entity class passed to `.leftJoin(Amphoe, 'amp', ...)` — never a
 *     raw table literal.
 *   - Amphoe IDs are stored as numeric strings in PostgreSQL
 *     (`@PrimaryColumn` on `Amphoe`). We coerce to `number` at the
 *     boundary to honor the `AmphoeLabel.amphoeId: number | null`
 *     contract from BE-W54-01, matching the Wave 53 tooling pattern
 *     (e.g. `location-breakdown.spec.ts` expects `Number(amphoeId)`).
 *   - Result labels are keyed by `projectId`, matching the
 *     `GeoEnrichmentResult.labels: Map<string, AmphoeLabel>` contract.
 *
 * CLAUDE.md references:
 *   - §12 audit rule (read-only — no `tracking_status` writes).
 *   - §13 geolocation (this is the executive read-enrichment; the §13
 *     LAO submit warning is a DIFFERENT, frontend-plus-backend flow).
 *   - §14 / §15 reads allowed on locked rows and frozen books.
 *   - §17.2 / §17.9 / §17.11.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';

import type {
  AmphoeLabel,
  GeoEnrichmentResult,
  IGeoEnrichment,
} from '../interfaces';
import type { MissingDimension, UnifiedProject } from '../types';
import { GEO_SUPPLEMENT_EXCLUDED } from '../advisory-copy';

/**
 * Server-authored static Thai advisory string surfaced when the
 * enrichment batch contains one or more SPG rows with NULL `amphoe_id`
 * (Wave 55 W55-BE-04 per-row semantics). Matches design memo §5.3
 * verbatim.
 *
 * Wave 54 BE-W54-07 unification: the canonical string lives in
 * `advisory-copy.ts` (single source of truth for advisories). This
 * re-export preserves the legacy `SUPPLEMENT_GEO_ADVISORY` name that
 * existing tests (`geo-enrichment.spec.ts`) assert against.
 */
export const SUPPLEMENT_GEO_ADVISORY = GEO_SUPPLEMENT_EXCLUDED;

/**
 * Dimension emitted when the batch contains at least one SPG row whose
 * `amphoeId` is NULL — Wave 55 per-row semantics.
 */
const SUPPLEMENT_GEO_DIMENSION: MissingDimension = 'geo:supplement';

@Injectable()
export class GeoEnrichmentService implements IGeoEnrichment {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async annotate(projects: UnifiedProject[]): Promise<GeoEnrichmentResult> {
    const labels = new Map<string, AmphoeLabel>();
    const missingDimensions: MissingDimension[] = [];
    const advisories: string[] = [];

    // Empty input → no mutation, no advisory (task §7 last bullet).
    if (projects.length === 0) {
      return { labels, missingDimensions, advisories };
    }

    const mainIds: string[] = [];
    const revisedIds: string[] = [];
    const supplementIds: string[] = [];
    // Wave 55 W55-BE-04: track SPG rows with a NULL `amphoeId` for the
    // per-row advisory. These are rows the aggregator projected with
    // `amphoeId: null` — historical backfill gap (no DB row to join).
    let hasSupplementWithoutAmphoe = false;

    for (const p of projects) {
      switch (p.projectKind) {
        case 'main':
          mainIds.push(p.projectId);
          break;
        case 'revised':
          revisedIds.push(p.projectId);
          break;
        case 'supplement':
          if (p.amphoeId == null) {
            // Historical gap — no FK to join. Advisory handles the UI
            // messaging; this row simply gets no label entry.
            hasSupplementWithoutAmphoe = true;
          } else {
            supplementIds.push(p.projectId);
          }
          break;
        default: {
          // Exhaustiveness check — if a new ProjectKind appears we
          // want a type error at compile time.
          const _exhaustive: never = p.projectKind;
          void _exhaustive;
        }
      }
    }

    // Fan out: main, revised, and supplement (rows with amphoe_id) in
    // parallel. Each query is a single LEFT JOIN against the Amphoe
    // entity to pull the Thai name and avoid an N+1 shape.
    const [mainRows, revisedRows, supplementRows] = await Promise.all([
      this.fetchMainAmphoeLabels(mainIds),
      this.fetchRevisedAmphoeLabels(revisedIds),
      this.fetchSupplementAmphoeLabels(supplementIds),
    ]);

    for (const row of mainRows) {
      labels.set(row.projectId, {
        amphoeId: row.amphoeId,
        amphoeName: row.amphoeName,
      });
    }
    for (const row of revisedRows) {
      labels.set(row.projectId, {
        amphoeId: row.amphoeId,
        amphoeName: row.amphoeName,
      });
    }
    for (const row of supplementRows) {
      labels.set(row.projectId, {
        amphoeId: row.amphoeId,
        amphoeName: row.amphoeName,
      });
    }

    if (hasSupplementWithoutAmphoe) {
      // Emitted once per run regardless of how many SPG rows had NULL
      // amphoeId — the advisory is batch-deduped at this layer.
      missingDimensions.push(SUPPLEMENT_GEO_DIMENSION);
      advisories.push(SUPPLEMENT_GEO_ADVISORY);
    }

    return { labels, missingDimensions, advisories };
  }

  private async fetchMainAmphoeLabels(ids: string[]): Promise<
    Array<{
      projectId: string;
      amphoeId: number | null;
      amphoeName: string | null;
    }>
  > {
    if (ids.length === 0) return [];

    // Entity-metadata resolution ONLY — repositories + entity classes.
    // No raw table literals. Zero writes.
    const rows: Array<{
      pgid: string;
      amphoeid: string | null;
      amphoename: string | null;
    }> = await this.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .leftJoin(Amphoe, 'amp', 'amp.id = pg.amphoe_id')
      .select('pg.id', 'pgid')
      .addSelect('pg.amphoe_id', 'amphoeid')
      .addSelect('amp.name', 'amphoename')
      .where('pg.id IN (:...ids)', { ids })
      .andWhere('pg.deletedAt IS NULL')
      .getRawMany();

    return rows.map((r) => ({
      projectId: r.pgid,
      amphoeId: coerceAmphoeId(r.amphoeid),
      // Trim guard: DB rows with empty strings must not masquerade as
      // valid labels. null propagates through to the downstream
      // `'(ไม่ระบุ)'` label handled at the Tier C assembly layer.
      amphoeName:
        r.amphoename && r.amphoename.trim().length > 0 ? r.amphoename : null,
    }));
  }

  private async fetchRevisedAmphoeLabels(ids: string[]): Promise<
    Array<{
      projectId: string;
      amphoeId: number | null;
      amphoeName: string | null;
    }>
  > {
    if (ids.length === 0) return [];

    const rows: Array<{
      rpgid: string;
      amphoeid: string | null;
      amphoename: string | null;
    }> = await this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .leftJoin(Amphoe, 'amp', 'amp.id = rpg.amphoe_id')
      .select('rpg.id', 'rpgid')
      .addSelect('rpg.amphoe_id', 'amphoeid')
      .addSelect('amp.name', 'amphoename')
      .where('rpg.id IN (:...ids)', { ids })
      .andWhere('rpg.deletedAt IS NULL')
      .getRawMany();

    return rows.map((r) => ({
      projectId: r.rpgid,
      amphoeId: coerceAmphoeId(r.amphoeid),
      amphoeName:
        r.amphoename && r.amphoename.trim().length > 0 ? r.amphoename : null,
    }));
  }

  /**
   * Wave 55 W55-BE-04 — supplement amphoe reader.
   *
   * Mirrors the main / revised readers: single LEFT JOIN against the
   * Amphoe entity via `spg.amphoe_id`. Only called for SPG projectIds
   * whose `amphoeId` is non-null in the incoming batch — rows without
   * a FK never reach this method and never incur a query cost.
   */
  private async fetchSupplementAmphoeLabels(ids: string[]): Promise<
    Array<{
      projectId: string;
      amphoeId: number | null;
      amphoeName: string | null;
    }>
  > {
    if (ids.length === 0) return [];

    const rows: Array<{
      spgid: string;
      amphoeid: string | null;
      amphoename: string | null;
    }> = await this.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .leftJoin(Amphoe, 'amp', 'amp.id = spg.amphoe_id')
      .select('spg.id', 'spgid')
      .addSelect('spg.amphoe_id', 'amphoeid')
      .addSelect('amp.name', 'amphoename')
      .where('spg.id IN (:...ids)', { ids })
      .andWhere('spg.deletedAt IS NULL')
      .getRawMany();

    return rows.map((r) => ({
      projectId: r.spgid,
      amphoeId: coerceAmphoeId(r.amphoeid),
      amphoeName:
        r.amphoename && r.amphoename.trim().length > 0 ? r.amphoename : null,
    }));
  }
}

/**
 * Coerce the raw amphoe id value (varchar numeric code in Postgres)
 * into `number | null`. Matches the Wave 53 tooling coercion pattern
 * (`executive-tool-handlers.ts`: `Number(r.amphoeid)`). Non-numeric or
 * empty values collapse to `null`.
 */
function coerceAmphoeId(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
