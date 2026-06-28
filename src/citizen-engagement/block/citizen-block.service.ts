import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import {
  CitizenBlockEntryDto,
  SetCitizenBlockResponseDto,
} from '../dto/citizen-block-response.dto';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenBlock } from '../entities/citizen-block.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenFollowService } from '../follow/citizen-follow.service';

/**
 * CitizenBlockService — mute / block another citizen (W-T1, §17.2 advisory).
 *
 *   - `mute`  → hide-only: the muter never sees the muted author's posts /
 *               comments, but the muted author CAN still interact.
 *   - `block` → mutual invisibility (neither sees the other) AND the blocked
 *               author cannot interact (and vice-versa). Setting `block` ALSO
 *               soft-deletes the person-follow edges in BOTH directions.
 *
 * PRIVACY (W-T1): the target is NEVER notified; lists are owner-scoped (a
 * citizen can only read / unset its OWN blocks). The directed pair is unique per
 * `(blocker, blocked) WHERE deleted_at IS NULL`; switching kind UPDATEs the
 * same live row (upsert).
 *
 * §17.3 isolation: touches ONLY `citizen_block` + `citizen_identities` (the
 * target-exists check is citizen_* → citizen_*) + `citizen_follow` (via
 * CitizenFollowService) + `citizen_audit_logs`. Audit goes EXCLUSIVELY to
 * `citizen_audit_logs` (NEVER `tracking_status`).
 */
@Injectable()
export class CitizenBlockService {
  constructor(
    @InjectRepository(CitizenBlock)
    private readonly blockRepo: Repository<CitizenBlock>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    // forwardRef: CitizenFollowService also depends on this service (for the
    // person-follow interaction guard), so the DI edge is mutual.
    @Inject(forwardRef(() => CitizenFollowService))
    private readonly followService: CitizenFollowService,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // WRITES
  // ---------------------------------------------------------------------------

  /**
   * Set (or switch) the caller's mute/block on `targetIdentityId`.
   *   - not-self        → `400 CITIZEN_BLOCK_SELF`
   *   - target missing  → `404 CITIZEN_IDENTITY_NOT_FOUND`
   *   - upsert kind on the live `(blocker, blocked)` pair
   *   - on `block` ALSO soft-delete person-follow edges BOTH ways
   * The target is NEVER notified (W-T1 PRIVATE).
   */
  async set(
    blockerId: string,
    targetId: string,
    kind: 'mute' | 'block',
  ): Promise<SetCitizenBlockResponseDto> {
    if (kind !== 'mute' && kind !== 'block') {
      throw new BadRequestException('CITIZEN_BLOCK_INVALID');
    }
    if (targetId === blockerId) {
      throw new BadRequestException('CITIZEN_BLOCK_SELF');
    }

    // The target MUST exist (active, not soft-deleted) — citizen_* → citizen_*.
    const target = await this.identityRepo.findOne({
      where: { id: targetId, status: 'active', deletedAt: IsNull() },
    });
    if (!target) {
      throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
    }

    return this.dataSource.transaction(async (em) => {
      const blockRepo = em.getRepository(CitizenBlock);
      const live = await blockRepo.findOne({
        where: {
          blockerIdentityId: blockerId,
          blockedIdentityId: targetId,
          deletedAt: IsNull(),
        },
      });

      if (live) {
        // Switch kind in place (e.g. mute → block). The partial-unique is on the
        // pair, so an UPDATE of `kind` never trips it.
        if (live.kind !== kind) {
          await blockRepo.update(live.id, { kind });
        }
      } else {
        // Race-safe insert (mirrors the follow/reaction toggle): `ON CONFLICT DO
        // NOTHING` lets a concurrent double-set hit the partial-unique
        // `… WHERE deleted_at IS NULL` without ABORTING the transaction.
        await blockRepo
          .createQueryBuilder()
          .insert()
          .values({
            blockerIdentityId: blockerId,
            blockedIdentityId: targetId,
            kind,
          })
          .orIgnore()
          .execute();
        // A concurrent insert may have won with a DIFFERENT kind — reconcile so
        // the caller's requested kind is the final state of the live row.
        await blockRepo
          .createQueryBuilder()
          .update()
          .set({ kind })
          .where('blocker_identity_id = :blockerId', { blockerId })
          .andWhere('blocked_identity_id = :targetId', { targetId })
          .andWhere('deleted_at IS NULL')
          .execute();
      }

      // A BLOCK implies the two citizens no longer follow each other —
      // soft-delete the person-follow edges in BOTH directions, same tx. `mute`
      // leaves follows untouched (mute is hide-only).
      if (kind === 'block') {
        await this.followService.softDeleteMutualPersonFollows(
          em,
          blockerId,
          targetId,
        );
      }

      await this.writeAudit(em, blockerId, 'block.set', targetId, {
        kind,
      });

      return { targetId, kind };
    });
  }

  /**
   * Remove the caller's mute/block on `targetId` (soft-delete the live edge).
   * Idempotent: unsetting an absent edge is a no-op. Does NOT restore the
   * previously-soft-deleted follow edges — un-block does not re-follow.
   */
  async unset(blockerId: string, targetId: string): Promise<{ removed: boolean }> {
    return this.dataSource.transaction(async (em) => {
      const blockRepo = em.getRepository(CitizenBlock);
      const live = await blockRepo.findOne({
        where: {
          blockerIdentityId: blockerId,
          blockedIdentityId: targetId,
          deletedAt: IsNull(),
        },
      });
      if (!live) {
        return { removed: false };
      }
      await blockRepo.softDelete(live.id);
      await this.writeAudit(em, blockerId, 'block.unset', targetId, {});
      return { removed: true };
    });
  }

  // ---------------------------------------------------------------------------
  // READS (owner-scoped / interaction helpers)
  // ---------------------------------------------------------------------------

  /**
   * The caller's OWN live blocks/mutes as `[{ targetId, kind }]`. Owner-scoped
   * from `req.user.identityId` — NO IDOR. PRIVACY (W-T1): this is the ONLY block
   * roster ever exposed (the caller's own outbound edges), never "who blocked me".
   */
  async listMyBlocks(blockerId: string): Promise<CitizenBlockEntryDto[]> {
    const rows = await this.blockRepo.find({
      where: { blockerIdentityId: blockerId, deletedAt: IsNull() },
    });
    return rows.map((r) => ({
      targetId: r.blockedIdentityId,
      kind: r.kind as 'mute' | 'block',
    }));
  }

  /**
   * READ-FILTER helper: the author identity ids the viewer MUTES-OR-BLOCKS
   * (either kind hides the author's content from the viewer). Anonymous viewer
   * (no id) → empty set. Used to exclude posts/comments from the viewer's reads.
   */
  async hiddenAuthorIdsFor(viewerId: string | undefined): Promise<string[]> {
    if (!viewerId) {
      return [];
    }
    const rows = await this.blockRepo.find({
      where: { blockerIdentityId: viewerId, deletedAt: IsNull() },
      select: ['blockedIdentityId'],
    });
    return rows.map((r) => r.blockedIdentityId);
  }

  /**
   * READ-FILTER + INTERACTION helper: the identity ids of citizens who have
   * `block`ed `targetId` (kind = 'block' ONLY — a `mute` is one-directional and
   * does NOT make the muter invisible to / un-interactable-by the muted).
   *
   *   - read side  → exclude posts whose author has BLOCKED the viewer (mutual
   *                  invisibility for 'block')
   *   - write side → an actor BLOCKED by the target is refused interaction
   *
   * Anonymous viewer (no id) → empty set.
   */
  async blockedBySet(targetId: string | undefined): Promise<string[]> {
    if (!targetId) {
      return [];
    }
    const rows = await this.blockRepo.find({
      where: {
        blockedIdentityId: targetId,
        kind: 'block',
        deletedAt: IsNull(),
      },
      select: ['blockerIdentityId'],
    });
    return rows.map((r) => r.blockerIdentityId);
  }

  /**
   * INTERACTION GUARD (block only): does a live `block` edge exist EITHER way
   * between `actorId` and `targetId`? `true` → the write (comment/react/follow/
   * repost) MUST be refused (`403 CITIZEN_BLOCKED`). `mute` edges are IGNORED —
   * mute never restricts interaction. Self (`actor === target`) → `false`.
   */
  async isBlockedEitherWay(
    actorId: string,
    targetId: string,
  ): Promise<boolean> {
    if (!actorId || !targetId || actorId === targetId) {
      return false;
    }
    const count = await this.blockRepo.count({
      where: [
        {
          blockerIdentityId: actorId,
          blockedIdentityId: targetId,
          kind: 'block',
          deletedAt: IsNull(),
        },
        {
          blockerIdentityId: targetId,
          blockedIdentityId: actorId,
          kind: 'block',
          deletedAt: IsNull(),
        },
      ],
    });
    return count > 0;
  }

  /**
   * Combined READ-FILTER set for a viewer: the union of (a) authors the viewer
   * mutes-or-blocks and (b) authors who have BLOCKED the viewer. These are the
   * author ids whose posts/comments MUST be excluded from the viewer's reads.
   * Anonymous viewer → empty set (the public board is shown unfiltered).
   */
  async excludedAuthorIdsForViewer(
    viewerId: string | undefined,
  ): Promise<Set<string>> {
    if (!viewerId) {
      return new Set();
    }
    const [hidden, blockedBy] = await Promise.all([
      this.hiddenAuthorIdsFor(viewerId),
      this.blockedBySet(viewerId),
    ]);
    return new Set([...hidden, ...blockedBy]);
  }

  /** Insert the isolated audit row (§17.3 — NEVER tracking_status). */
  private async writeAudit(
    em: EntityManager,
    blockerId: string,
    action: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const row = em.getRepository(CitizenAuditLog).create({
      actorKind: 'citizen',
      actorId: blockerId,
      action,
      targetKind: 'block',
      targetId,
      detail,
    });
    await em.getRepository(CitizenAuditLog).save(row);
  }
}
