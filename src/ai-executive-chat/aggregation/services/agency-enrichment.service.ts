/**
 * Wave 54 — BE-W54-05 — AgencyEnrichment concrete service.
 *
 * Implements `IAgencyEnrichment` (foundation interface). Annotates a
 * `UnifiedProject[]` batch with Thai `GovernmentAgency.name` via a
 * LEFT JOIN against the `GovernmentAgency` entity. All three project
 * kinds (`main`, `revised`, `supplement`) carry a
 * `responsible_agency_id` column, so all three are join targets here.
 *
 * Contract highlights (task §7 Backend Requirements):
 *   - Entity-metadata resolution ONLY. `.getRepository(GovernmentAgency)`
 *     + `.createQueryBuilder` with the entity class as the JOIN target.
 *     Zero raw SQL table literals.
 *   - NEVER projects the numeric agency id as the LLM-visible label.
 *     `agencyId` rides alongside `agencyName` in the `AgencyLabel`
 *     shape for downstream joins, but `agencyName` is the label.
 *   - Fallback label `'ไม่ระบุ'` when the FK is NULL or the joined
 *     agency is soft-deleted (`deleted_at IS NOT NULL`). Matches the
 *     Wave 53 `getTeamWorkloadSummary` fallback string.
 *   - §17 PII discipline — `GovernmentAgency` is an organisation, not a
 *     person. `name` is a public organisation label. No person-level
 *     fields (`createdBy`, `firstName`, `lastName`, `citizenId`) are
 *     projected here or anywhere else in this service.
 *   - §17.2 advisory-only — no workflow gating.
 *   - §17.11 — accepts already-asserted executive context; role check
 *     is a Tier C gate.
 *
 * Implementation notes:
 *   - Runs at most THREE parallel repository queries, one per project
 *     kind, each a single LEFT JOIN. Empty ID lists short-circuit to
 *     `[]` without issuing a query.
 *   - Agency IDs are stored as numeric strings
 *     (`@PrimaryGeneratedColumn()` → auto-incrementing integer mapped
 *     to string). Coerced to `number` at the boundary to match the
 *     `AgencyLabel.agencyId: number | null` foundation contract.
 *   - Result labels are keyed by `projectId`, matching the
 *     `AgencyEnrichmentResult.labels: Map<string, AgencyLabel>`
 *     contract from BE-W54-01.
 *
 * CLAUDE.md references:
 *   - §12 audit rule (read-only — no `tracking_status` writes).
 *   - §14 / §15 reads allowed on locked rows and frozen books.
 *   - §17 PII discipline, §17.2 / §17.11.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';

import type {
  AgencyEnrichmentResult,
  AgencyLabel,
  IAgencyEnrichment,
} from '../interfaces';
import type { MissingDimension, UnifiedProject } from '../types';

/**
 * Server-authored static Thai fallback label. Exported for spec
 * byte-equality assertions (§17.9 prompt-injection defense).
 */
export const UNRESOLVED_AGENCY_LABEL = 'ไม่ระบุ' as const;

@Injectable()
export class AgencyEnrichmentService implements IAgencyEnrichment {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async annotate(
    projects: UnifiedProject[],
  ): Promise<AgencyEnrichmentResult> {
    const labels = new Map<string, AgencyLabel>();
    const missingDimensions: MissingDimension[] = [];
    const advisories: string[] = [];

    if (projects.length === 0) {
      return { labels, missingDimensions, advisories };
    }

    const mainIds: string[] = [];
    const revisedIds: string[] = [];
    const supplementIds: string[] = [];

    for (const p of projects) {
      switch (p.projectKind) {
        case 'main':
          mainIds.push(p.projectId);
          break;
        case 'revised':
          revisedIds.push(p.projectId);
          break;
        case 'supplement':
          supplementIds.push(p.projectId);
          break;
        default: {
          const _exhaustive: never = p.projectKind;
          void _exhaustive;
        }
      }
    }

    const [mainRows, revisedRows, supplementRows] = await Promise.all([
      this.fetchMainLabels(mainIds),
      this.fetchRevisedLabels(revisedIds),
      this.fetchSupplementLabels(supplementIds),
    ]);

    for (const row of [...mainRows, ...revisedRows, ...supplementRows]) {
      labels.set(row.projectId, {
        agencyId: row.agencyId,
        agencyName: row.agencyName,
      });
    }

    return { labels, missingDimensions, advisories };
  }

  private async fetchMainLabels(
    ids: string[],
  ): Promise<
    Array<{ projectId: string; agencyId: number | null; agencyName: string }>
  > {
    if (ids.length === 0) return [];

    const rows: Array<{
      pgid: string;
      agencyid: string | null;
      agencyname: string | null;
    }> = await this.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      // Soft-deleted agency → `ga.name` will be NULL even though the
      // FK is set. Handled in `resolveLabel` via fallback.
      .leftJoin(
        GovernmentAgency,
        'ga',
        'ga.id = pg.responsible_agency_id AND ga.deleted_at IS NULL',
      )
      .select('pg.id', 'pgid')
      .addSelect('pg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .where('pg.id IN (:...ids)', { ids })
      .andWhere('pg.deletedAt IS NULL')
      .getRawMany();

    return rows.map((r) => ({
      projectId: r.pgid,
      ...resolveLabel(r.agencyid, r.agencyname),
    }));
  }

  private async fetchRevisedLabels(
    ids: string[],
  ): Promise<
    Array<{ projectId: string; agencyId: number | null; agencyName: string }>
  > {
    if (ids.length === 0) return [];

    const rows: Array<{
      rpgid: string;
      agencyid: string | null;
      agencyname: string | null;
    }> = await this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .leftJoin(
        GovernmentAgency,
        'ga',
        'ga.id = rpg.responsible_agency_id AND ga.deleted_at IS NULL',
      )
      .select('rpg.id', 'rpgid')
      .addSelect('rpg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .where('rpg.id IN (:...ids)', { ids })
      .andWhere('rpg.deletedAt IS NULL')
      .getRawMany();

    return rows.map((r) => ({
      projectId: r.rpgid,
      ...resolveLabel(r.agencyid, r.agencyname),
    }));
  }

  private async fetchSupplementLabels(
    ids: string[],
  ): Promise<
    Array<{ projectId: string; agencyId: number | null; agencyName: string }>
  > {
    if (ids.length === 0) return [];

    const rows: Array<{
      spgid: string;
      agencyid: string | null;
      agencyname: string | null;
    }> = await this.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .leftJoin(
        GovernmentAgency,
        'ga',
        'ga.id = spg.responsible_agency_id AND ga.deleted_at IS NULL',
      )
      .select('spg.id', 'spgid')
      .addSelect('spg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .where('spg.id IN (:...ids)', { ids })
      .andWhere('spg.deletedAt IS NULL')
      .getRawMany();

    return rows.map((r) => ({
      projectId: r.spgid,
      ...resolveLabel(r.agencyid, r.agencyname),
    }));
  }
}

/**
 * Map a raw `(agencyId, agencyName)` pair from the database into the
 * `AgencyLabel` shape. Empty / whitespace-only names collapse to the
 * Thai fallback `'ไม่ระบุ'`. Soft-deleted agencies (join predicate
 * excluded them) surface as `agencyName = null → 'ไม่ระบุ'`.
 *
 * NEVER emits `agency#<id>`-style surrogate labels. The numeric id is
 * carried alongside the name for downstream joins but MUST NOT be
 * substituted as the visible label.
 */
function resolveLabel(
  rawAgencyId: string | null,
  rawAgencyName: string | null,
): { agencyId: number | null; agencyName: string } {
  const agencyId = coerceAgencyId(rawAgencyId);
  const trimmed = rawAgencyName?.trim() ?? '';
  const agencyName = trimmed.length > 0 ? trimmed : UNRESOLVED_AGENCY_LABEL;
  return { agencyId, agencyName };
}

function coerceAgencyId(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
