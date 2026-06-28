import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { GrantDto } from '../dto/citizen-grant-response.dto';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenBackendAccessGrant } from '../entities/citizen-backend-access-grant.entity';

/**
 * CitizenGrantService — backend-access grants for INTERNAL users (C4, plan D6).
 *
 * An un-granted internal user is VIEW-ONLY; a super-admin grant unlocks a
 * capability (`moderate|insight|access_mgmt|respond`). This is a GRANT TABLE,
 * NOT a new global role — `roles.enum.ts` is untouched.
 *
 * §17.3 isolation: this service touches ONLY `citizen_*` tables. `userId` and
 * `decidedByWorkHistoryId` are PLAIN uuids with NO FK into `users` /
 * `work_history`. The "one active grant per (user, capability)" rule is the
 * partial-unique `uq_citizen_grant_one_granted WHERE state = 'granted'` (M0).
 * Audit goes EXCLUSIVELY to `citizen_audit_logs` with `actorKind = 'internal'`
 * — NEVER `tracking_status`.
 */
@Injectable()
export class CitizenGrantService {
  constructor(
    @InjectRepository(CitizenBackendAccessGrant)
    private readonly grantRepo: Repository<CitizenBackendAccessGrant>,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // WRITES (super-admin console)
  // ---------------------------------------------------------------------------

  /**
   * Grant `capability` to `userId`. Idempotent: if a live `granted` row already
   * exists it is returned unchanged. Otherwise we flip an existing
   * `pending`/`revoked` row to `granted` (or insert a fresh one), recording the
   * decider + decision time. Respects the partial-unique (one granted per
   * (user, capability)) — race-safe by virtue of running in a transaction.
   */
  async grant(
    deciderWorkHistoryId: string,
    userId: string,
    capability: string,
  ): Promise<GrantDto> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(CitizenBackendAccessGrant);

      // A live granted row → idempotent return (no mutation, no audit).
      const granted = await repo.findOne({
        where: { userId, capability, state: 'granted' },
      });
      if (granted) {
        return this.toGrantDto(granted);
      }

      // Reuse a pending/revoked row if one exists; else insert a new row.
      const reusable = await repo.findOne({
        where: { userId, capability, state: In(['pending', 'revoked']) },
      });

      const now = new Date();
      let saved: CitizenBackendAccessGrant;
      if (reusable) {
        reusable.state = 'granted';
        reusable.decidedByWorkHistoryId = deciderWorkHistoryId;
        reusable.decidedAt = now;
        saved = await repo.save(reusable);
      } else {
        const row = repo.create({
          userId,
          capability,
          state: 'granted',
          decidedByWorkHistoryId: deciderWorkHistoryId,
          decidedAt: now,
        });
        saved = await repo.save(row);
      }

      await this.writeAudit(em, deciderWorkHistoryId, 'grant.grant', 'grant', saved.id, {
        userId,
        capability,
      });

      return this.toGrantDto(saved);
    });
  }

  /**
   * Revoke `capability` from `userId`. Flips the live `granted` row to
   * `revoked`. No-op (returns null) when nothing is granted.
   */
  async revoke(
    deciderWorkHistoryId: string,
    userId: string,
    capability: string,
  ): Promise<GrantDto | null> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(CitizenBackendAccessGrant);

      const granted = await repo.findOne({
        where: { userId, capability, state: 'granted' },
      });
      if (!granted) {
        // Nothing live to revoke — no-op, no audit.
        return null;
      }

      granted.state = 'revoked';
      granted.decidedByWorkHistoryId = deciderWorkHistoryId;
      granted.decidedAt = new Date();
      const saved = await repo.save(granted);

      await this.writeAudit(em, deciderWorkHistoryId, 'grant.revoke', 'grant', saved.id, {
        userId,
        capability,
      });

      return this.toGrantDto(saved);
    });
  }

  // ---------------------------------------------------------------------------
  // READS
  // ---------------------------------------------------------------------------

  /** All grants (super-admin console), newest-first. */
  async listGrants(): Promise<GrantDto[]> {
    const rows = await this.grantRepo.find({
      order: { updatedAt: 'DESC' },
    });
    return rows.map((r) => this.toGrantDto(r));
  }

  /** The caller's own grants, newest-first. */
  async myGrants(userId: string): Promise<GrantDto[]> {
    const rows = await this.grantRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
    return rows.map((r) => this.toGrantDto(r));
  }

  /** True iff a live `granted` row exists for (user, capability). Guard input. */
  async hasGrant(userId: string, capability: string): Promise<boolean> {
    const count = await this.grantRepo.count({
      where: { userId, capability, state: 'granted' },
    });
    return count > 0;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** Insert an isolated audit row (§17.3 — NEVER tracking_status). */
  private async writeAudit(
    em: EntityManager,
    actorWorkHistoryId: string,
    action: string,
    targetKind: string,
    targetId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const row = em.getRepository(CitizenAuditLog).create({
      actorKind: 'internal',
      actorId: actorWorkHistoryId,
      action,
      targetKind,
      targetId,
      detail,
    });
    await em.getRepository(CitizenAuditLog).save(row);
  }

  private toGrantDto(g: CitizenBackendAccessGrant): GrantDto {
    return {
      id: g.id,
      userId: g.userId,
      capability: g.capability,
      state: g.state,
      decidedByWorkHistoryId: g.decidedByWorkHistoryId ?? null,
      decidedAt: g.decidedAt ? g.decidedAt.toISOString() : null,
      // `?? new Date()` guards the insert path where @CreateDateColumn is not
      // yet hydrated on the returned object.
      createdAt: (g.requestedAt ?? new Date()).toISOString(),
    };
  }
}
