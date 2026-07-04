import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WorkHistory } from '../work-history/entities/work-history.entity';
import { CitizenPlanningEntry } from './entities/citizen-planning-entry.entity';
import { UpsertPlanningDto } from './dto/upsert-planning.dto';

/**
 * CitizenPlanningService — the SINGLE writer of the executive private
 * planning layer (§17.2 advisory / §17.3 isolation). All access is scoped to
 * the caller's CURRENT WorkHistory (§1 / §4 ownership); one executive never
 * reads or mutates another's rows.
 *
 * This service NEVER writes `tracking_status`, never touches a project table,
 * and never gates a workflow transition. It only reads/writes
 * `citizen_planning_entries`.
 */
@Injectable()
export class CitizenPlanningService {
  constructor(
    @InjectRepository(CitizenPlanningEntry)
    private readonly planningRepo: Repository<CitizenPlanningEntry>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  /**
   * Resolve the caller's current WorkHistory id (the ownership key). Mirrors
   * the canonical executive-surface resolver: the actor MUST have a current
   * WorkHistory with `workStatus = approved`. The controller guard already
   * asserts approval; this is defense-in-depth and yields the WH id.
   */
  private async resolveOwnerWorkHistoryId(userId: string): Promise<string> {
    const wh = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus'],
    });
    if (!wh) throw new ForbiddenException('WORK_HISTORY_NOT_FOUND');
    const status = wh.workStatus?.name?.toLowerCase() ?? '';
    if (status !== 'approved')
      throw new ForbiddenException('WORK_STATUS_NOT_APPROVED');
    return wh.id;
  }

  /** All of the caller's planning rows (the top-100 idea set is small, so the
   *  FE fetches the whole per-user set once and joins client-side). */
  async listMine(userId: string): Promise<CitizenPlanningEntry[]> {
    const ownerWorkHistoryId = await this.resolveOwnerWorkHistoryId(userId);
    return this.planningRepo.find({
      where: { ownerWorkHistoryId },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Upsert the caller's planning state for one idea. Only provided fields are
   * applied; an empty-string `note` clears it (stored null). Idempotent per
   * (owner, ideaId) via the unique index.
   *
   * Concurrency: `findOne`→`save` is check-then-act, so two rapid writes for the
   * same (owner, ideaId) can both miss and race to INSERT. The unique index
   * `uq_citizen_planning_owner_idea` makes the loser fail with Postgres
   * `23505`; we catch it and re-run once — the second pass now finds the
   * winner's row and UPDATEs it, preserving the partial-merge semantics.
   */
  async upsert(
    userId: string,
    ideaId: string,
    dto: UpsertPlanningDto,
  ): Promise<CitizenPlanningEntry> {
    const ownerWorkHistoryId = await this.resolveOwnerWorkHistoryId(userId);
    try {
      return await this.applyUpsert(ownerWorkHistoryId, ideaId, dto);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // A concurrent insert won the race; the row now exists — merge onto it.
        return await this.applyUpsert(ownerWorkHistoryId, ideaId, dto);
      }
      throw err;
    }
  }

  private async applyUpsert(
    ownerWorkHistoryId: string,
    ideaId: string,
    dto: UpsertPlanningDto,
  ): Promise<CitizenPlanningEntry> {
    let entry = await this.planningRepo.findOne({
      where: { ownerWorkHistoryId, ideaId },
    });
    if (!entry) {
      entry = this.planningRepo.create({ ownerWorkHistoryId, ideaId });
    }

    if (dto.triageStatus !== undefined) entry.triageStatus = dto.triageStatus;
    if (dto.isFlagged !== undefined) entry.isFlagged = dto.isFlagged;
    if (dto.note !== undefined) {
      const trimmed = dto.note.trim();
      entry.note = trimmed.length ? trimmed : null;
    }
    // `undefined` leaves the score untouched; explicit `null` clears it.
    if (dto.effortScore !== undefined) entry.effortScore = dto.effortScore;

    return this.planningRepo.save(entry);
  }

  /** Postgres unique_violation (23505), read off either the error or its
   *  underlying driver error (TypeORM `QueryFailedError`). */
  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; driverError?: { code?: string } };
    return e?.code === '23505' || e?.driverError?.code === '23505';
  }

  /** Clear the caller's planning state for one idea (removes the row). */
  async clear(userId: string, ideaId: string): Promise<{ cleared: boolean }> {
    const ownerWorkHistoryId = await this.resolveOwnerWorkHistoryId(userId);
    const res = await this.planningRepo.delete({ ownerWorkHistoryId, ideaId });
    return { cleared: (res.affected ?? 0) > 0 };
  }
}
