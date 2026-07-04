import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { CitizenBlockService } from '../block/citizen-block.service';
import { FollowSetsDto } from '../dto/citizen-follow-response.dto';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenFollow } from '../entities/citizen-follow.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';

/** The 5 idea categories — the only valid `category` follow targets. */
const FOLLOW_CATEGORIES = ['road', 'water', 'public', 'safety', 'other'];

/** Loose RFC-4122 uuid shape (a `person` target_key is a citizen identity uuid). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Max length of an amphoe follow `target_key`. Amphoe ids are short string
 * codes (e.g. "3001"), NOT uuids — the `Amphoe` entity's `id` is a
 * `@PrimaryColumn` set from a code. 16 chars is a sane upper bound (well under
 * the `target_key` varchar(64) column).
 */
const AMPHOE_KEY_MAX_LEN = 16;

/**
 * CitizenFollowService — follow AREAS (amphoe), TOPICS (category), and
 * (W-GATE-1, §10 APPROVED) other PEOPLE.
 *
 * W-GATE-1: `targetKind` is `amphoe` | `category` | `person`. The toggle
 * mirrors the C2 reaction toggle: find the live row → soft-delete it (unfollow)
 * OR insert via `orIgnore()` (race-safe follow). Live follows drive the
 * personalized "following" feed (areas, topics, AND followed people).
 *
 * PRIVACY (D16): person follows are exposed ONLY as (a) public COUNTS
 * (`getFollowerCount`) and (b) the caller's OWN following list
 * (`listFollowedPeople`). The follower/following ROSTER (who-follows-whom) is
 * NEVER exposed.
 *
 * §17.3 isolation: touches ONLY `citizen_follow` + `citizen_identities` (the
 * person-exists check is citizen_* → citizen_*) + `citizen_audit_logs`. Audit
 * goes EXCLUSIVELY to `citizen_audit_logs` (NEVER `tracking_status`).
 */
@Injectable()
export class CitizenFollowService {
  constructor(
    @InjectRepository(CitizenFollow)
    private readonly followRepo: Repository<CitizenFollow>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    // forwardRef: CitizenBlockService depends on this service (for the block →
    // soft-delete-follows side-effect), so the DI edge is mutual.
    @Inject(forwardRef(() => CitizenBlockService))
    private readonly blockService: CitizenBlockService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Toggle the caller's follow of `(targetKind, targetKey)`.
   *   - category → targetKey MUST be one of the 5 idea categories
   *   - amphoe   → targetKey MUST be a non-empty amphoe code (≤16 chars)
   *   - person   → targetKey MUST be a uuid, NOT self, and an EXISTING + active
   *                (status='active', not soft-deleted) citizen identity
   * Invalid shape → `400 CITIZEN_FOLLOW_INVALID`; self → `400
   * CITIZEN_FOLLOW_SELF`; missing/blocked person → `404
   * CITIZEN_IDENTITY_NOT_FOUND`. Returns the resulting state.
   */
  async toggleFollow(
    identityId: string,
    targetKind: string,
    targetKey: string,
  ): Promise<{ following: boolean }> {
    if (
      targetKind !== 'amphoe' &&
      targetKind !== 'category' &&
      targetKind !== 'person'
    ) {
      throw new BadRequestException('CITIZEN_FOLLOW_INVALID');
    }
    if (targetKind === 'category' && !FOLLOW_CATEGORIES.includes(targetKey)) {
      throw new BadRequestException('CITIZEN_FOLLOW_INVALID');
    }
    if (
      targetKind === 'amphoe' &&
      (targetKey.trim().length === 0 || targetKey.length > AMPHOE_KEY_MAX_LEN)
    ) {
      // Amphoe ids are short string codes (e.g. "3001"), NOT uuids — accept any
      // non-empty, reasonably-short code rather than requiring a uuid.
      throw new BadRequestException('CITIZEN_FOLLOW_INVALID');
    }
    if (targetKind === 'person') {
      // Person target_key is the followed identity_id (a plain uuid).
      if (!UUID_RE.test(targetKey)) {
        throw new BadRequestException('CITIZEN_FOLLOW_INVALID');
      }
      // No self-follow (checked BEFORE the existence read — cheapest + clearest).
      if (targetKey === identityId) {
        throw new BadRequestException('CITIZEN_FOLLOW_SELF');
      }
      // The followed person MUST exist + be active (not blocked, not deleted).
      const target = await this.identityRepo.findOne({
        where: { id: targetKey, status: 'active', deletedAt: IsNull() },
        // §17.3 / PDPA: existence check only — don't pull *_enc / *_hash.
        select: { id: true },
      });
      if (!target) {
        throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
      }

      // W-T1 INTERACTION GUARD (block only): an actor blocked by the target —
      // or who blocked the target — cannot follow them. `mute` does NOT
      // restrict (the muter may still follow; they just won't see the content).
      if (await this.blockService.isBlockedEitherWay(identityId, targetKey)) {
        throw new ForbiddenException('CITIZEN_BLOCKED');
      }
    }

    return this.dataSource.transaction(async (em) => {
      const followRepo = em.getRepository(CitizenFollow);
      const live = await followRepo.findOne({
        where: {
          followerIdentityId: identityId,
          targetKind,
          targetKey,
          deletedAt: IsNull(),
        },
      });

      let following: boolean;
      if (live) {
        await followRepo.softDelete(live.id);
        following = false;
      } else {
        // Race-safe insert (same as the C2 reaction toggle): `ON CONFLICT DO
        // NOTHING` lets a concurrent double-toggle hit the partial-unique
        // `… WHERE deleted_at IS NULL` without ABORTING the transaction.
        await followRepo
          .createQueryBuilder()
          .insert()
          .values({ followerIdentityId: identityId, targetKind, targetKey })
          .orIgnore()
          .execute();
        following = true;
      }

      await this.writeAudit(em, identityId, {
        targetKind,
        targetKey,
        following,
      });

      return { following };
    });
  }

  /**
   * The caller's live follows, split into amphoe codes + category strings +
   * followed-person identity ids (W-GATE-1). `people` is the caller's OWN
   * following list — D16-safe (never another citizen's roster).
   */
  async listFollowSets(identityId: string): Promise<FollowSetsDto> {
    const rows = await this.followRepo.find({
      where: { followerIdentityId: identityId, deletedAt: IsNull() },
    });
    const amphoes: string[] = [];
    const categories: string[] = [];
    const people: string[] = [];
    for (const row of rows) {
      if (row.targetKind === 'amphoe') {
        amphoes.push(row.targetKey);
      } else if (row.targetKind === 'category') {
        categories.push(row.targetKey);
      } else if (row.targetKind === 'person') {
        people.push(row.targetKey);
      }
    }
    return { amphoes, categories, people };
  }

  /**
   * Public DTO shape `{ amphoes, categories, people }` — same data as
   * listFollowSets (`amphoes` holds amphoe codes, not uuids).
   */
  async listFollows(identityId: string): Promise<FollowSetsDto> {
    return this.listFollowSets(identityId);
  }

  /**
   * W-GATE-1: the identity_ids of the people the caller follows (their OWN
   * following list). PRIVACY (D16): this is the ONLY roster ever exposed — the
   * caller's OWN outbound follows. NEVER another citizen's followers/following.
   */
  async listFollowedPeople(identityId: string): Promise<string[]> {
    const rows = await this.followRepo.find({
      where: {
        followerIdentityId: identityId,
        targetKind: 'person',
        deletedAt: IsNull(),
      },
    });
    return rows.map((row) => row.targetKey);
  }

  /**
   * W-GATE-1: live count of citizens who follow `targetIdentityId`. PRIVACY
   * (D16): the COUNT is public; the roster (WHO follows) is NEVER exposed — this
   * returns a number only. Counts live person-follows pointing at the target.
   */
  async getFollowerCount(targetIdentityId: string): Promise<number> {
    return this.followRepo.count({
      where: {
        targetKind: 'person',
        targetKey: targetIdentityId,
        deletedAt: IsNull(),
      },
    });
  }

  /**
   * W-T1: soft-delete the live `person` follow edges between two citizens in
   * BOTH directions (A→B and B→A). Called inside the block transaction when a
   * citizen BLOCKs another — a block implies they no longer follow each other.
   * Idempotent: a soft-delete of an already-absent / already-deleted edge is a
   * no-op (the `deleted_at IS NULL` filter selects nothing). Runs on the
   * caller's `EntityManager` so it commits atomically with the block write.
   */
  async softDeleteMutualPersonFollows(
    em: EntityManager,
    aIdentityId: string,
    bIdentityId: string,
  ): Promise<void> {
    const followRepo = em.getRepository(CitizenFollow);
    const live = await followRepo.find({
      where: [
        {
          followerIdentityId: aIdentityId,
          targetKind: 'person',
          targetKey: bIdentityId,
          deletedAt: IsNull(),
        },
        {
          followerIdentityId: bIdentityId,
          targetKind: 'person',
          targetKey: aIdentityId,
          deletedAt: IsNull(),
        },
      ],
    });
    for (const row of live) {
      await followRepo.softDelete(row.id);
    }
  }

  /** Insert the isolated audit row (§17.3 — NEVER tracking_status). */
  private async writeAudit(
    em: EntityManager,
    identityId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const row = em.getRepository(CitizenAuditLog).create({
      actorKind: 'citizen',
      actorId: identityId,
      action: 'follow.toggle',
      targetKind: 'follow',
      targetId: null,
      detail,
    });
    await em.getRepository(CitizenAuditLog).save(row);
  }
}
