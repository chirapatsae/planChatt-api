import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenBlock } from '../entities/citizen-block.entity';
import { CitizenBookmark } from '../entities/citizen-bookmark.entity';
import { CitizenFollow } from '../entities/citizen-follow.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenNotification } from '../entities/citizen-notification.entity';
import { CitizenPollVote } from '../entities/citizen-poll-vote.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenPostComment } from '../entities/citizen-post-comment.entity';
import { CitizenPostMedia } from '../entities/citizen-post-media.entity';
import { CitizenPostReaction } from '../entities/citizen-post-reaction.entity';
import { CitizenReport } from '../entities/citizen-report.entity';
import { CitizenStory } from '../entities/citizen-story.entity';
import { CitizenStoryReaction } from '../entities/citizen-story-reaction.entity';
import { CitizenStoryView } from '../entities/citizen-story-view.entity';
import { CitizenChatConversation } from '../entities/citizen-chat-conversation.entity';
import { CitizenChatMessage } from '../entities/citizen-chat-message.entity';
import { CitizenChatReadState } from '../entities/citizen-chat-read-state.entity';
import { decryption, isLikelyCiphertext } from '../../util/encryption.util';

/**
 * The alias placed on an erased identity's `display_alias`. After erasure the
 * row keeps its uuid (so audit / soft-deleted content stays referentially sane)
 * but carries NO PII and this neutral Thai label as the only public name.
 */
export const ERASED_DISPLAY_ALIAS = 'บัญชีที่ถูกลบ';

/** Shape of the one-object DSAR export (caller-owned data only). */
export interface CitizenDsarExport {
  exportedAt: string;
  /** PII-safe profile — alias + joinedAt + consentVersion ONLY. */
  profile: {
    id: string;
    displayAlias: string;
    joinedAt: string;
    consentVersion: string | null;
  };
  posts: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  reactions: Array<Record<string, unknown>>;
  bookmarks: Array<Record<string, unknown>>;
  follows: Array<Record<string, unknown>>;
  pollVotes: Array<Record<string, unknown>>;
  stories: Array<Record<string, unknown>>;
  /** FB-6 — stories the caller has VIEWED (viewer side). */
  storyViews: Array<Record<string, unknown>>;
  /** FB-6 — the caller's story emoji REACTIONS (reactor side). */
  storyReactions: Array<Record<string, unknown>>;
  blocks: Array<Record<string, unknown>>;
  reports: Array<Record<string, unknown>>;
  /** Community Chat — the caller's conversations + their authored messages
   *  (bodies DECRYPTED for the export, since it is the caller's own data). */
  chatConversations: Array<Record<string, unknown>>;
  chatMessages: Array<Record<string, unknown>>;
}

/**
 * CitizenDsarService — the PDPA DSAR (Data Subject Access Request) surface
 * (W-G1): self-service DATA EXPORT + ACCOUNT ERASURE for the ThaID citizen.
 *
 * Both operations are OWNER-scoped: the acting `identityId` is ALWAYS resolved
 * by `CitizenJwtGuard` from `req.user.identityId` (NEVER a body/param), so a
 * citizen can only export / erase their OWN data — no IDOR. Grounded in the
 * /me pattern + identity repo of `CitizenProfileService` and the
 * `session_version` revocation semantics of `CitizenAuthService` /
 * `CitizenJwtGuard`.
 *
 * §17.2 advisory / §17.3 isolation: this service touches ONLY `citizen_*`
 * tables. It NEVER reads or writes any project entity / `users` /
 * `work_history` / `tracking_status`. Its audit goes EXCLUSIVELY to
 * `citizen_audit_logs`, and the erasure audit row carries NO raw PII (only the
 * actor uuid + per-kind soft-delete counts).
 */
@Injectable()
export class CitizenDsarService {
  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // EXPORT (owner-scoped, read-only)
  // ---------------------------------------------------------------------------

  /**
   * Build ONE JSON object of EVERYTHING the caller owns.
   *
   * PRIVACY (PDPA / §17.3): the `profile` block exposes ONLY alias + joinedAt +
   * consentVersion. The identity PII columns — `national_id_hash`,
   * `thaid_sub_hash`, `national_id_enc`, `full_name_enc` — are NEVER read into
   * the export. No OTHER citizen's content is included; rows reference other
   * citizens by opaque uuid only (the alias join is unnecessary for owned rows,
   * whose author IS the caller).
   *
   * Soft-deleted rows are INCLUDED — a DSAR export is "everything we hold about
   * you", including content you removed but that is still retained.
   */
  async exportMine(identityId: string): Promise<CitizenDsarExport> {
    const identity = await this.identityRepo.findOne({
      where: { id: identityId, deletedAt: IsNull() },
    });
    if (!identity) {
      throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
    }

    // All reads via `withDeleted()` so the export is complete (includes the
    // caller's own soft-deleted content). Every filter is owner-scoped.
    const [
      posts,
      comments,
      reactions,
      bookmarks,
      follows,
      pollVotes,
      stories,
      storyViews,
      storyReactions,
      blocks,
      reports,
    ] = await Promise.all([
      this.dataSource.getRepository(CitizenPost).find({
        where: { authorIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenPostComment).find({
        where: { authorIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenPostReaction).find({
        where: { identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenBookmark).find({
        where: { bookmarkerIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenFollow).find({
        where: { followerIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenPollVote).find({
        where: { voterIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenStory).find({
        where: { authorIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      // FB-6 — stories the caller has VIEWED (no soft-delete column: hard rows).
      this.dataSource.getRepository(CitizenStoryView).find({
        where: { viewerIdentityId: identityId },
        order: { viewedAt: 'ASC' },
      }),
      // FB-6 — the caller's story emoji REACTIONS (no soft-delete column).
      this.dataSource.getRepository(CitizenStoryReaction).find({
        where: { identityId },
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenBlock).find({
        where: { blockerIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenReport).find({
        where: { reporterIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
    ]);

    // Community Chat — conversations the caller is in (either side) + the
    // caller's OWN authored messages (bodies decrypted for the caller's export).
    const [chatConversations, chatMessages] = await Promise.all([
      this.dataSource.getRepository(CitizenChatConversation).find({
        where: [
          { initiatorIdentityId: identityId },
          { participantIdentityId: identityId },
        ],
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(CitizenChatMessage).find({
        where: { authorIdentityId: identityId },
        withDeleted: true,
        order: { createdAt: 'ASC' },
      }),
    ]);
    const chatMessageRows = await Promise.all(
      chatMessages.map(async (m) => ({
        id: m.id,
        conversationId: m.conversationId,
        body: isLikelyCiphertext(m.body) ? await this.safeDecrypt(m.body) : m.body,
        hasImage: !!m.imagePath,
        moderationState: m.moderationState,
        createdAt: m.createdAt,
        deletedAt: m.deletedAt,
      })),
    );

    return {
      exportedAt: new Date().toISOString(),
      profile: {
        id: identity.id,
        displayAlias: identity.displayAlias,
        joinedAt: (identity.createdAt ?? new Date()).toISOString(),
        consentVersion: identity.consentVersion,
        // EXCLUDED for privacy (NEVER serialized): thaidSubHash, nationalIdHash,
        // nationalIdEnc, fullNameEnc, sessionVersion, status, deletedAt.
      },
      posts: posts.map((p) => this.toExportRow(p)),
      comments: comments.map((c) => this.toExportRow(c)),
      reactions: reactions.map((r) => this.toExportRow(r)),
      bookmarks: bookmarks.map((b) => this.toExportRow(b)),
      follows: follows.map((f) => this.toExportRow(f)),
      pollVotes: pollVotes.map((v) => this.toExportRow(v)),
      stories: stories.map((s) => this.toExportRow(s)),
      storyViews: storyViews.map((v) => this.toExportRow(v)),
      storyReactions: storyReactions.map((r) => this.toExportRow(r)),
      blocks: blocks.map((b) => this.toExportRow(b)),
      reports: reports.map((r) => this.toExportRow(r)),
      chatConversations: chatConversations.map((c) => ({
        id: c.id,
        // The other member as an opaque uuid (no alias join for owned rows).
        participantId:
          c.initiatorIdentityId === identityId
            ? c.participantIdentityId
            : c.initiatorIdentityId,
        lastMessageAt: c.lastMessageAt,
        createdAt: c.createdAt,
        deletedAt: c.deletedAt,
      })),
      chatMessages: chatMessageRows,
    };
  }

  /** Decrypt a chat body for export; never throw into the export pipeline. */
  private async safeDecrypt(cipher: string): Promise<string> {
    try {
      return await decryption(cipher);
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // ERASE (owner-scoped, transactional)
  // ---------------------------------------------------------------------------

  /**
   * RIGHT-TO-ERASURE: in ONE transaction, soft-delete ALL of the caller's
   * engagement content, ANONYMIZE the identity, BUMP `session_version` (which
   * invalidates the live JWT via `CitizenJwtGuard`), and write a retained
   * `citizen_audit_logs` erasure row (NO raw PII).
   *
   * Clearing `thaid_sub_hash` means a future ThaID login for the same person
   * no longer matches this row, so a FRESH identity is minted — the erased row
   * is a tombstone that is never reused.
   *
   * §17.3: ONLY `citizen_*` rows owned by the caller are touched — NEVER any
   * other citizen's data, and NEVER a project / users / tracking_status row.
   */
  async eraseMine(
    identityId: string,
  ): Promise<{ erased: true; counts: Record<string, number> }> {
    return this.dataSource.transaction(async (em) => {
      const identity = await em.getRepository(CitizenIdentity).findOne({
        where: { id: identityId, deletedAt: IsNull() },
      });
      if (!identity) {
        throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
      }

      // --- Phase 1: soft-delete ALL the caller's content (owner-scoped) ------
      // `softDelete` sets `deleted_at = now()` on every matching LIVE row; it
      // does NOT touch already-soft-deleted rows and NEVER any other citizen's
      // rows (every criteria below is keyed on the caller's identity column).
      const counts: Record<string, number> = {
        posts: await this.softDeleteOwned(em, CitizenPost, {
          authorIdentityId: identityId,
        }),
        media: await this.softDeleteOwned(em, CitizenPostMedia, {
          ownerIdentityId: identityId,
        }),
        comments: await this.softDeleteOwned(em, CitizenPostComment, {
          authorIdentityId: identityId,
        }),
        reactions: await this.softDeleteOwned(em, CitizenPostReaction, {
          identityId,
        }),
        bookmarks: await this.softDeleteOwned(em, CitizenBookmark, {
          bookmarkerIdentityId: identityId,
        }),
        follows: await this.softDeleteOwned(em, CitizenFollow, {
          followerIdentityId: identityId,
        }),
        pollVotes: await this.softDeleteOwned(em, CitizenPollVote, {
          voterIdentityId: identityId,
        }),
        stories: await this.softDeleteOwned(em, CitizenStory, {
          authorIdentityId: identityId,
        }),
        // FB-6 — the caller's story VIEW + REACTION rows carry NO soft-delete
        // column (24h-ephemeral by design), so erasure HARD-deletes them.
        storyViews: await this.hardDeleteOwned(em, CitizenStoryView, {
          viewerIdentityId: identityId,
        }),
        storyReactions: await this.hardDeleteOwned(em, CitizenStoryReaction, {
          identityId,
        }),
        blocks: await this.softDeleteOwned(em, CitizenBlock, {
          blockerIdentityId: identityId,
        }),
        reports: await this.softDeleteOwned(em, CitizenReport, {
          reporterIdentityId: identityId,
        }),
        // The caller's personal notification inbox (rows addressed TO them).
        notifications: await this.softDeleteOwned(em, CitizenNotification, {
          recipientIdentityId: identityId,
        }),
        // Community Chat — soft-delete the caller's OWN messages. The shared
        // conversation row + the OTHER party's messages are NOT touched (that is
        // the other citizen's data); the caller's identity anonymization below
        // makes them show as the erased alias to their counterpart.
        chatMessages: await this.softDeleteOwned(em, CitizenChatMessage, {
          authorIdentityId: identityId,
        }),
        // NOTE: citizen_official_response is authored by INTERNAL staff
        // (responder_work_history_id / responder_user_id) — a CITIZEN never
        // authors one, so there is no citizen-owned official-response row to
        // erase here. Included in the design for completeness; vacuous in
        // practice for a citizen caller.
      };

      // Pseudonymize chat content: NULL the body of every message the caller
      // authored (including already-soft-deleted rows) so no plaintext-recoverable
      // ciphertext survives erasure. Then drop the caller's read-watermarks
      // (non-content metadata; the read-state entity has no soft-delete column).
      await em
        .getRepository(CitizenChatMessage)
        .update({ authorIdentityId: identityId }, { body: '' });
      await em
        .getRepository(CitizenChatReadState)
        .delete({ readerIdentityId: identityId });

      // --- Phase 2: anonymize the identity + revoke the session --------------
      identity.nationalIdHash = null;
      // Clearing thaid_sub_hash de-links the ThaID `sub` → a future login mints
      // a FRESH identity instead of resurrecting this tombstone.
      identity.thaidSubHash = '';
      identity.nationalIdEnc = null;
      identity.fullNameEnc = null;
      // AUTH-REDESIGN (2026-07): scrub the email/password/Google auth PII too.
      // Without this the encrypted email (email_enc) survives a right-to-erasure
      // request, and email_hash / google_sub_hash keep the address "taken" so the
      // owner can never re-register. Nulling all four erases the PII AND frees the
      // identifiers (both hashes are partial-unique WHERE NOT NULL, so multiple
      // erased tombstones coexist). email_verified_at cleared for consistency.
      identity.emailEnc = null;
      identity.emailHash = null;
      identity.passwordHash = null;
      identity.googleSubHash = null;
      identity.emailVerifiedAt = null;
      identity.displayAlias = ERASED_DISPLAY_ALIAS;
      identity.status = 'deleted';
      // Bump session_version so the live citizen JWT is rejected by
      // CitizenJwtGuard on its next request (session_version mismatch). Also
      // belt-and-braces: the guard already 401s once status !== 'active' and
      // once deleted_at is set.
      identity.sessionVersion = (identity.sessionVersion ?? 0) + 1;
      identity.deletedAt = new Date();
      await em.getRepository(CitizenIdentity).save(identity);

      // --- Phase 3: retained erasure audit row (NO raw PII) -----------------
      // Carries ONLY the actor uuid + per-kind soft-delete counts — never an
      // alias, national id, hash, or enc value. The audit table is append-only
      // and has NO FK into citizen_identities, so it survives the erasure.
      await em.getRepository(CitizenAuditLog).save(
        em.getRepository(CitizenAuditLog).create({
          actorKind: 'citizen',
          actorId: identityId,
          action: 'account.erase',
          targetKind: 'identity',
          targetId: identityId,
          detail: { counts },
        }),
      );

      return { erased: true, counts };
    });
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Soft-delete every LIVE row of `entity` matching the owner-scoped `criteria`
   * inside the caller's transaction. Returns the affected row count. Never
   * touches rows that don't match the caller's identity column.
   */
  private async softDeleteOwned<T extends object>(
    em: EntityManager,
    entity: new () => T,
    criteria: Record<string, unknown>,
  ): Promise<number> {
    const result = await em.getRepository(entity).softDelete(criteria as never);
    return result.affected ?? 0;
  }

  /**
   * HARD-delete every row of `entity` matching the owner-scoped `criteria` inside
   * the caller's transaction. For citizen_* tables with NO soft-delete column
   * (FB-6 story views/reactions are 24h-ephemeral), erasure removes the rows
   * outright. Returns the affected row count.
   */
  private async hardDeleteOwned<T extends object>(
    em: EntityManager,
    entity: new () => T,
    criteria: Record<string, unknown>,
  ): Promise<number> {
    const result = await em.getRepository(entity).delete(criteria as never);
    return result.affected ?? 0;
  }

  /**
   * Serialize a citizen-owned entity row to a plain export object. Entity rows
   * carry NO PII columns (PII lives ONLY on citizen_identities, which is handled
   * separately by the `profile` block), so the full row is safe to emit. Dates
   * are normalized to ISO strings.
   */
  private toExportRow(row: object): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
  }
}
