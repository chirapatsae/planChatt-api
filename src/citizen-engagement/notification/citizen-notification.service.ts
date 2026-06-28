import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import {
  ListNotificationsResponseDto,
  NotificationDto,
} from '../dto/citizen-notification-response.dto';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenNotification } from '../entities/citizen-notification.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenNotificationBus } from './citizen-notification.bus';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * CitizenNotificationService — "someone interacted with YOUR post" (C3, D14).
 *
 * A notification is created SYNCHRONOUSLY in the SAME transaction as the
 * triggering comment/heart write (single-recipient → no fanout). The write
 * helpers take the caller's `EntityManager` so the notification commits with
 * the comment/heart. A self-interaction (recipient === actor) is a NO-OP.
 *
 * D11/D16: read endpoints expose only the caller's OWN inbox (recipient = me)
 * — there is NO follower-of-me roster. Reads expose only the actor's
 * `displayAlias` (never PII columns).
 *
 * §17.3 isolation: touches ONLY `citizen_notification` / `citizen_identities`
 * / `citizen_post`. NO `tracking_status` write.
 */
@Injectable()
export class CitizenNotificationService {
  constructor(
    @InjectRepository(CitizenNotification)
    private readonly notificationRepo: Repository<CitizenNotification>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    private readonly dataSource: DataSource,
    // W-T2: in-memory realtime fan-out. Optional in the DI graph so the legacy
    // `new CitizenNotificationService(...)` unit-spec construction stays valid;
    // when absent, `emitRealtimePing` is a no-op (write path is unaffected).
    private readonly notificationBus?: CitizenNotificationBus,
  ) {}

  /**
   * W-T2: best-effort realtime ping AFTER a notification row is saved. The
   * publish is wrapped so a bus failure NEVER throws into the notification write
   * path (§17.2 advisory). The event carries ONLY a recipient routing key + a
   * type string — NO PII (§17.3); the FE refetches the authoritative unread
   * count, so a missed/duplicate ping is harmless.
   */
  private emitRealtimePing(recipientIdentityId: string): void {
    try {
      this.notificationBus?.publish({ recipientIdentityId, type: 'notification' });
    } catch {
      // swallow — realtime is advisory and must never break the write.
    }
  }

  // ---------------------------------------------------------------------------
  // WRITES (called inside the comment/heart transaction)
  // ---------------------------------------------------------------------------

  /** Notify the post author that `actor` commented. Self-comment → NO-OP. */
  async notifyOnComment(
    em: EntityManager,
    post: CitizenPost,
    actorIdentityId: string,
    commentId: string,
  ): Promise<void> {
    if (post.authorIdentityId === actorIdentityId) {
      return;
    }
    const row = em.getRepository(CitizenNotification).create({
      recipientIdentityId: post.authorIdentityId,
      actorIdentityId,
      kind: 'comment',
      postId: post.id,
      commentId,
    });
    await em.getRepository(CitizenNotification).save(row);
    this.emitRealtimePing(post.authorIdentityId);
  }

  /**
   * Notify the post author that `actor` hearted. Self-heart → NO-OP.
   * Called ONLY when a heart is ADDED (never on unheart).
   */
  async notifyOnHeart(
    em: EntityManager,
    post: CitizenPost,
    actorIdentityId: string,
  ): Promise<void> {
    if (post.authorIdentityId === actorIdentityId) {
      return;
    }
    const row = em.getRepository(CitizenNotification).create({
      recipientIdentityId: post.authorIdentityId,
      actorIdentityId,
      kind: 'heart',
      postId: post.id,
      commentId: null,
    });
    await em.getRepository(CitizenNotification).save(row);
    this.emitRealtimePing(post.authorIdentityId);
  }

  /**
   * W-S6: notify a citizen that `actor` @mentioned them in a POST or a COMMENT.
   * `mentionedIdentityId` is the resolved target (the recipient); the actor is
   * the post / comment author. The caller (`CitizenMentionService`) has ALREADY
   * dropped self / dups / blocked pairs, so this helper does NOT re-check them —
   * but a defensive self-mention guard keeps the helper safe to call directly.
   *
   * `commentId` distinguishes a comment-mention (the FE renders "…ในความคิดเห็น")
   * from a post-mention ("…ในโพสต์"); it is reused as the plain "what was
   * created" pointer, exactly like the comment / official-response paths. Called
   * inside the post / comment write transaction; emits the realtime ping after
   * the row saves (W-T2).
   */
  async notifyOnMention(
    em: EntityManager,
    actorIdentityId: string,
    mentionedIdentityId: string,
    post: CitizenPost,
    commentId?: string,
  ): Promise<void> {
    // Defensive self-mention NO-OP — compare against the ACTOR (the author of
    // the post OR comment that holds the mention), NOT the post author. For a
    // COMMENT mention the actor is the commenter, so a commenter mentioning the
    // post author is a legitimate notification that must NOT be skipped — and
    // the actor shown to the recipient must be the commenter, not the post owner.
    if (actorIdentityId === mentionedIdentityId) {
      return;
    }
    const row = em.getRepository(CitizenNotification).create({
      recipientIdentityId: mentionedIdentityId,
      actorIdentityId,
      kind: 'mention',
      postId: post.id,
      // `comment_id` = the comment the mention lives in (NULL for a post-mention)
      // — reused as the plain "where was I mentioned" pointer.
      commentId: commentId ?? null,
    });
    await em.getRepository(CitizenNotification).save(row);
    this.emitRealtimePing(mentionedIdentityId);
  }

  /**
   * Notify the post author that an INTERNAL staff member posted an official
   * response (C4, plan D12). There is NO citizen actor — `actorIdentityId` is
   * NULL — so the FE renders a fixed official-response copy (no actor alias).
   * Called inside the official-response write transaction.
   */
  async notifyOnOfficialResponse(
    em: EntityManager,
    post: CitizenPost,
    responseId: string,
  ): Promise<void> {
    const row = em.getRepository(CitizenNotification).create({
      recipientIdentityId: post.authorIdentityId,
      actorIdentityId: null,
      kind: 'official_response',
      postId: post.id,
      // `comment_id` is reused as a plain "what was created" pointer.
      commentId: responseId,
    });
    await em.getRepository(CitizenNotification).save(row);
    this.emitRealtimePing(post.authorIdentityId);
  }

  /**
   * W-G2: notify the post author that an INTERNAL staff member ADVANCED the
   * issue-handling status of an official response. Reuses the C4
   * `official_response` kind (NO new notification kind / CHECK widening) — there
   * is NO citizen actor (`actorIdentityId` NULL), and `commentId` re-points to
   * the official-response row so the FE resolves the now-current `status` from
   * the post's official-response DTO. Called inside the status-update tx.
   */
  async notifyOnOfficialResponseStatus(
    em: EntityManager,
    post: CitizenPost,
    responseId: string,
  ): Promise<void> {
    const row = em.getRepository(CitizenNotification).create({
      recipientIdentityId: post.authorIdentityId,
      actorIdentityId: null,
      kind: 'official_response',
      postId: post.id,
      // `comment_id` re-used as a plain "what was updated" pointer (the response).
      commentId: responseId,
    });
    await em.getRepository(CitizenNotification).save(row);
    this.emitRealtimePing(post.authorIdentityId);
  }

  // ---------------------------------------------------------------------------
  // READS (caller's own inbox only)
  // ---------------------------------------------------------------------------

  /** The caller's inbox, newest-first, keyset-paginated (mirrors the C2 list). */
  async listNotifications(
    identityId: string,
    limit?: number,
    beforeCreatedAt?: string,
    beforeId?: string,
  ): Promise<ListNotificationsResponseDto> {
    const take = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const qb = this.notificationRepo
      .createQueryBuilder('n')
      .where('n.recipientIdentityId = :identityId', { identityId })
      .andWhere('n.deletedAt IS NULL');

    if (beforeCreatedAt && beforeId) {
      qb.andWhere(
        '(n.createdAt < :beforeCreatedAt OR (n.createdAt = :beforeCreatedAt AND n.id < :beforeId))',
        { beforeCreatedAt, beforeId },
      );
    }

    qb.orderBy('n.createdAt', 'DESC').addOrderBy('n.id', 'DESC').take(take);

    const rows = await qb.getMany();

    // Batch-resolve actor aliases + post titles in ONE query each (avoid N+1).
    // `official_response` notices have a NULL actor — filter those out here.
    const aliasByIdentity = await this.batchLoadAliases(
      rows
        .map((n) => n.actorIdentityId)
        .filter((id): id is string => id !== null),
    );
    const postById = await this.batchLoadPosts(
      rows
        .map((n) => n.postId)
        .filter((id): id is string => id !== null),
    );

    const items = rows.map((n) =>
      this.toNotificationDto(n, aliasByIdentity, postById),
    );

    const nextCursor =
      rows.length === take
        ? {
            createdAt: rows[rows.length - 1].createdAt.toISOString(),
            id: rows[rows.length - 1].id,
          }
        : null;

    return { items, nextCursor };
  }

  /** Count the caller's unread notifications. */
  async unreadCount(identityId: string): Promise<{ count: number }> {
    const count = await this.notificationRepo.count({
      where: {
        recipientIdentityId: identityId,
        readAt: IsNull(),
        deletedAt: IsNull(),
      },
    });
    return { count };
  }

  /**
   * Mark ONE of the caller's notifications read. Ownership is enforced by the
   * `recipientIdentityId = me` filter — `404` if it is not yours / missing.
   */
  async markRead(
    identityId: string,
    notificationId: string,
  ): Promise<{ ok: true }> {
    const result = await this.notificationRepo.update(
      {
        id: notificationId,
        recipientIdentityId: identityId,
        deletedAt: IsNull(),
      },
      { readAt: new Date() },
    );
    if (!result.affected) {
      throw new NotFoundException('CITIZEN_NOTIFICATION_NOT_FOUND');
    }
    return { ok: true as const };
  }

  /** Mark ALL of the caller's unread notifications read. */
  async markAllRead(identityId: string): Promise<{ ok: true }> {
    await this.notificationRepo.update(
      {
        recipientIdentityId: identityId,
        readAt: IsNull(),
        deletedAt: IsNull(),
      },
      { readAt: new Date() },
    );
    return { ok: true as const };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async batchLoadAliases(
    identityIds: string[],
  ): Promise<Map<string, string>> {
    const byId = new Map<string, string>();
    const unique = [...new Set(identityIds)];
    if (unique.length === 0) {
      return byId;
    }
    // §17.3 / PDPA: load ONLY the id + public alias — never the *_enc / *_hash
    // PII columns (this map only ever exposes displayAlias).
    const rows = await this.identityRepo.find({
      where: { id: In(unique) },
      select: { id: true, displayAlias: true },
    });
    for (const r of rows) {
      byId.set(r.id, r.displayAlias ?? '');
    }
    return byId;
  }

  private async batchLoadPosts(
    postIds: string[],
  ): Promise<Map<string, CitizenPost>> {
    const byId = new Map<string, CitizenPost>();
    const unique = [...new Set(postIds)];
    if (unique.length === 0) {
      return byId;
    }
    const rows = await this.postRepo.find({ where: { id: In(unique) } });
    for (const r of rows) {
      byId.set(r.id, r);
    }
    return byId;
  }

  private toNotificationDto(
    n: CitizenNotification,
    aliasByIdentity: Map<string, string>,
    postById: Map<string, CitizenPost>,
  ): NotificationDto {
    const post = n.postId ? postById.get(n.postId) ?? null : null;
    // `official_response` notices have a NULL actor → empty alias. The FE
    // renders a fixed official-response copy and ignores the alias for that kind.
    const displayAlias =
      n.actorIdentityId !== null
        ? aliasByIdentity.get(n.actorIdentityId) ?? ''
        : '';
    return {
      id: n.id,
      kind: n.kind,
      createdAt: (n.createdAt ?? new Date()).toISOString(),
      read: n.readAt !== null,
      // W-GATE-1: `actor.id` = the acting citizen's identity uuid (opaque
      // handle for a profile link). NULL actor (official_response) → '' (the FE
      // ignores actor for that kind), mirroring the empty-alias fallback above.
      actor: { id: n.actorIdentityId ?? '', displayAlias },
      post: post ? { id: post.id, title: post.title } : null,
    };
  }
}
