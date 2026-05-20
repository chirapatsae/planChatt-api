/**
 * Public Archive Service.
 *
 * Read-only access to assembled development plan books for ANONYMOUS
 * (non-logged-in) callers. The Local Development Plan is a public-record
 * document under พ.ร.บ. ข้อมูลข่าวสารฯ, so the assembled PDF + minimal
 * metadata are exposed without authentication.
 *
 * Differences from `BookAssemblyService.getAssemblyHistory`:
 *   1. NO `loadAndValidateWorkHistory` call (no user context).
 *   2. Only returns versions where `status = COMPLETED` (drafts and
 *      deprecated versions are never exposed publicly).
 *   3. Strips PII from the payload — no creator user, no work-history.
 *      Only `bookName`, `versionNumber`, `mergedAt`, `totalPages` survive
 *      the transform.
 *   4. Returns supplements as a parallel timeline once SupplementAssembly
 *      surfaces a public-ready service (currently a stub returning []).
 *
 * Project-search:
 *   `searchProjects(q)` returns approved projects (PG + RPG) whose title
 *   contains `q`, joined back to a plan that has at least one COMPLETED
 *   book version. This answers the citizen-facing question "ตำบลเรามี
 *   โครงการสร้างถนนหน้าบ้านในปีไหน อยู่ในเล่มไหน?".
 *
 * Status table: §17.2 advisory — viewing the archive does not gate
 * any workflow transition; CLAUDE.md ownership rules are unaffected.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';

import { BookAssemblyVersion } from 'src/book-assembly/entities/book-assembly-version.entity';
import {
  BookAssemblySourceType,
  BookAssemblyVersionStatus,
} from 'src/book-assembly/enums/book-assembly.enums';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { BookAssemblyService } from 'src/book-assembly/book-assembly.service';

/* ── Public DTO shapes (no PII) ──────────────────────────────────── */

export interface PublicVersionDto {
  versionNumber: number;
  mergedAt: string;
  totalPages: number | null;
  /** Download URL for streaming the assembled PDF. */
  downloadUrl: string;
}

export interface PublicRevisionDto {
  revisionId: string;
  revisionName: string;
  versions: PublicVersionDto[];
}

export interface PublicPlanDto {
  planId: string;
  planName: string;
  startYear: number;
  endYear: number;
  mainBook: { versions: PublicVersionDto[] } | null;
  editRevisions: PublicRevisionDto[];
  changeRevisions: PublicRevisionDto[];
}

export interface PublicProjectSearchHit {
  projectId: string;
  projectTitle: string;
  projectYear: number;
  /** Which book the project belongs to. */
  sourceType: 'main_plan' | 'edit_revision' | 'change_revision';
  sourceId: string;
  planId: string;
  planName: string;
  bookName: string;
}

@Injectable()
export class PublicArchiveService {
  constructor(
    @InjectRepository(BookAssemblyVersion)
    private readonly versionRepo: Repository<BookAssemblyVersion>,
    @InjectRepository(DevelopmentPlan)
    private readonly devPlanRepo: Repository<DevelopmentPlan>,
    @InjectRepository(DevelopmentPlanRevision)
    private readonly devPlanRevisionRepo: Repository<DevelopmentPlanRevision>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,
    private readonly bookAssemblyService: BookAssemblyService,
  ) {}

  /**
   * Build the path the FE will hand to its axios instance. The leading
   * `/v1` is NOT included because `VITE_API_BASE_URL` on the FE already
   * carries the version prefix.
   */
  private buildDownloadUrl(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    versionNumber: number,
  ): string {
    return `/public/plans/${sourceType}/${sourceId}/v${versionNumber}/pdf`;
  }

  /**
   * Map a COMPLETED BookAssemblyVersion entity to the PII-stripped
   * public shape. Returns null if the version is NOT completed (drafts
   * and deprecated versions are never exposed publicly).
   */
  private toPublicVersion(v: BookAssemblyVersion): PublicVersionDto | null {
    if (v.status !== BookAssemblyVersionStatus.COMPLETED) return null;
    return {
      versionNumber: v.versionNumber,
      mergedAt: v.mergedAt instanceof Date ? v.mergedAt.toISOString() : String(v.mergedAt),
      totalPages: v.totalPages,
      downloadUrl: this.buildDownloadUrl(v.sourceType, v.sourceId, v.versionNumber),
    };
  }

  /* ── #1 List plans (with optional filters) ───────────────────── */

  /**
   * Filter contract:
   *   - `q` — case-insensitive contains on plan name
   *   - `year` — single fiscal year that must fall within
   *     `[startYear, endYear]`
   *   - `type` — book type discriminator: 'all' | 'main' | 'edit' |
   *     'change'. Plans without a matching version are dropped when
   *     `type` is anything other than 'all'.
   *
   * The shape mirrors `BookAssemblyService.getAssemblyHistory` so the
   * FE can reuse most of its rendering primitives — minus the PII.
   */
  async listPlans(filters: {
    q?: string;
    year?: number;
    type?: 'all' | 'main' | 'edit' | 'change';
  }): Promise<PublicPlanDto[]> {
    const { q, year, type = 'all' } = filters;

    // Plan WHERE: name contains q (if provided), year inside range.
    const planWhere: Record<string, unknown> = {};
    if (q && q.trim().length > 0) {
      planWhere.name = ILike(`%${q.trim()}%`);
    }
    const plans = await this.devPlanRepo.find({
      where: planWhere,
      order: { startYear: 'DESC' },
    });
    const yearFiltered = year
      ? plans.filter((p) => p.startYear <= year && year <= p.endYear)
      : plans;
    if (yearFiltered.length === 0) return [];

    const planIds = yearFiltered.map((p) => p.id);

    // Fetch versions + revisions in parallel.
    const [revisions, mainVersions] = await Promise.all([
      this.devPlanRevisionRepo.find({
        where: { developmentPlan: { id: In(planIds) } },
        relations: ['revisionType', 'developmentPlan'],
        order: { revisionNumber: 'ASC' },
      }),
      this.versionRepo.find({
        where: {
          sourceType: BookAssemblySourceType.MAIN_PLAN,
          sourceId: In(planIds),
          status: BookAssemblyVersionStatus.COMPLETED,
        },
        order: { versionNumber: 'DESC' },
      }),
    ]);

    const revisionIds = revisions.map((r) => r.id);
    let childVersions: BookAssemblyVersion[] = [];
    if (revisionIds.length > 0) {
      childVersions = await this.versionRepo.find({
        where: [
          {
            sourceType: BookAssemblySourceType.EDIT_REVISION,
            sourceId: In(revisionIds),
            status: BookAssemblyVersionStatus.COMPLETED,
          },
          {
            sourceType: BookAssemblySourceType.CHANGE_REVISION,
            sourceId: In(revisionIds),
            status: BookAssemblyVersionStatus.COMPLETED,
          },
        ],
        order: { versionNumber: 'DESC' },
      });
    }

    // Index by (sourceType:sourceId).
    const versionMap = new Map<string, BookAssemblyVersion[]>();
    for (const v of [...mainVersions, ...childVersions]) {
      const key = `${v.sourceType}:${v.sourceId}`;
      if (!versionMap.has(key)) versionMap.set(key, []);
      versionMap.get(key)!.push(v);
    }

    // Revisions grouped by plan + by type.
    const revByPlan = new Map<string, DevelopmentPlanRevision[]>();
    for (const r of revisions) {
      const pid = r.developmentPlan?.id;
      if (!pid) continue;
      if (!revByPlan.has(pid)) revByPlan.set(pid, []);
      revByPlan.get(pid)!.push(r);
    }

    const buildRevisionDtos = (
      planRevisions: DevelopmentPlanRevision[],
      typeName: 'แก้ไข' | 'เปลี่ยนแปลง',
      sourceType: BookAssemblySourceType,
    ): PublicRevisionDto[] => {
      return planRevisions
        .filter((r) => r.revisionType?.name === typeName)
        .map((r) => {
          const versions = (versionMap.get(`${sourceType}:${r.id}`) ?? [])
            .map((v) => this.toPublicVersion(v))
            .filter((v): v is PublicVersionDto => v !== null);
          return {
            revisionId: r.id,
            revisionName: `${typeName} ครั้งที่ ${r.revisionNumber}`,
            versions,
          };
        })
        .filter((r) => r.versions.length > 0); // only emit revisions that have a published version
    };

    const result: PublicPlanDto[] = yearFiltered.map((plan) => {
      const mainKey = `${BookAssemblySourceType.MAIN_PLAN}:${plan.id}`;
      const mainVersionDtos = (versionMap.get(mainKey) ?? [])
        .map((v) => this.toPublicVersion(v))
        .filter((v): v is PublicVersionDto => v !== null);

      const planRevisions = revByPlan.get(plan.id) ?? [];
      const editRevisions = buildRevisionDtos(
        planRevisions,
        'แก้ไข',
        BookAssemblySourceType.EDIT_REVISION,
      );
      const changeRevisions = buildRevisionDtos(
        planRevisions,
        'เปลี่ยนแปลง',
        BookAssemblySourceType.CHANGE_REVISION,
      );

      return {
        planId: plan.id,
        planName: plan.name,
        startYear: plan.startYear,
        endYear: plan.endYear,
        mainBook: mainVersionDtos.length > 0 ? { versions: mainVersionDtos } : null,
        editRevisions,
        changeRevisions,
      };
    });

    // Type filter (drop plans whose matching book is empty).
    if (type === 'main') return result.filter((p) => p.mainBook !== null);
    if (type === 'edit') return result.filter((p) => p.editRevisions.length > 0);
    if (type === 'change') return result.filter((p) => p.changeRevisions.length > 0);

    // Drop plans with NO published content at all.
    return result.filter(
      (p) =>
        p.mainBook !== null ||
        p.editRevisions.length > 0 ||
        p.changeRevisions.length > 0,
    );
  }

  /* ── #2 Stream PDF (anon access) ─────────────────────────────── */

  /**
   * Resolves the absolute disk path of a COMPLETED book version's
   * merged PDF. Drafts and deprecated versions are explicitly rejected
   * so an anonymous caller cannot stumble onto an unpublished file by
   * URL guess.
   */
  async resolvePublicPdfPath(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    versionNumber: number,
  ): Promise<string> {
    const version = await this.versionRepo.findOne({
      where: { sourceType, sourceId, versionNumber },
    });
    if (!version) {
      throw new NotFoundException('ไม่พบเล่มที่ระบุ');
    }
    if (version.status !== BookAssemblyVersionStatus.COMPLETED) {
      // 404 (not 403) — do not reveal that the version exists but is
      // private. Anonymous callers see "not found" uniformly.
      throw new NotFoundException('ไม่พบเล่มที่ระบุ');
    }
    return this.bookAssemblyService.getMergedPdfPath(sourceType, sourceId, versionNumber);
  }

  /* ── #3 Project search ──────────────────────────────────────── */

  /**
   * Find approved projects whose title contains `q`, scoped to plans
   * that have at least one COMPLETED published book. Returns up to
   * `limit` results combined across PG + RPG, ordered by mergedAt of
   * the parent book (newest first).
   *
   * Only approved projects are returned to avoid surfacing in-flight
   * drafts via title search. Approved status check is via the latest
   * `TrackingStatus` row.
   */
  async searchProjects(
    q: string,
    limit: number = 50,
  ): Promise<PublicProjectSearchHit[]> {
    const trimmed = q?.trim();
    if (!trimmed || trimmed.length < 2) return [];

    // Pre-fetch plans that have at least one published main book to
    // avoid surfacing projects whose plan has no public assembled copy.
    const publishedMainVersions = await this.versionRepo.find({
      where: {
        sourceType: BookAssemblySourceType.MAIN_PLAN,
        status: BookAssemblyVersionStatus.COMPLETED,
      },
      order: { mergedAt: 'DESC' },
    });
    const publishedPlanIds = new Set(publishedMainVersions.map((v) => v.sourceId));
    if (publishedPlanIds.size === 0) return [];

    // PG search.
    const pgRows = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .leftJoinAndSelect('pg.developmentPlan', 'plan')
      .leftJoin('pg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .where('pg.title ILIKE :q', { q: `%${trimmed}%` })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('plan.id IN (:...planIds)', { planIds: Array.from(publishedPlanIds) })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .orderBy('pg.createdAt', 'DESC')
      .limit(limit)
      .getMany();

    const pgHits: PublicProjectSearchHit[] = pgRows.map((pg) => ({
      projectId: pg.id,
      projectTitle: pg.title,
      projectYear: pg.projectYear,
      sourceType: 'main_plan',
      sourceId: pg.developmentPlan?.id ?? '',
      planId: pg.developmentPlan?.id ?? '',
      planName: pg.developmentPlan?.name ?? '',
      bookName: pg.developmentPlan?.name ?? '',
    }));

    // RPG search — joined via developmentPlanRevision → developmentPlan.
    const rpgRows = await this.revisedProjectGroupRepo
      .createQueryBuilder('rpg')
      .leftJoinAndSelect('rpg.developmentPlanRevision', 'rev')
      .leftJoinAndSelect('rev.developmentPlan', 'plan')
      .leftJoinAndSelect('rev.revisionType', 'revType')
      .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .where('rpg.title ILIKE :q', { q: `%${trimmed}%` })
      .andWhere('rpg.deletedAt IS NULL')
      .andWhere('plan.id IN (:...planIds)', { planIds: Array.from(publishedPlanIds) })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .orderBy('rpg.createdAt', 'DESC')
      .limit(limit)
      .getMany();

    const rpgHits: PublicProjectSearchHit[] = rpgRows
      .filter((rpg) => rpg.developmentPlanRevision?.id)
      .map((rpg) => {
        const rev = rpg.developmentPlanRevision!;
        const isChange = rev.revisionType?.name === 'เปลี่ยนแปลง';
        return {
          projectId: rpg.id,
          projectTitle: rpg.title,
          projectYear: rpg.projectYear,
          sourceType: isChange ? 'change_revision' : 'edit_revision',
          sourceId: rev.id,
          planId: rev.developmentPlan?.id ?? '',
          planName: rev.developmentPlan?.name ?? '',
          bookName: `${rev.revisionType?.name ?? ''} ครั้งที่ ${rev.revisionNumber}`,
        };
      });

    return [...pgHits, ...rpgHits].slice(0, limit);
  }
}
