import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { OfficialResponseDto } from '../dto/citizen-official-response.dto';
import { OfficialResponseStatus } from '../dto/update-official-response-status.dto';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenOfficialResponse } from '../entities/citizen-official-response.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenNotificationService } from '../notification/citizen-notification.service';

/**
 * W-G2: the issue-handling status lifecycle, in forward order. A transition is
 * valid iff the target rank is >= the current rank (forward-or-same); a lower
 * rank is rejected with `400 OFFICIAL_RESPONSE_STATUS_INVALID`.
 */
const STATUS_ORDER: OfficialResponseStatus[] = [
  'received',
  'in_progress',
  'resolved',
];

/**
 * The internal responder identity, resolved at the controller from the JWT
 * context (NEVER the request body). All four fields are PLAIN values snapshotted
 * into `citizen_official_response` — NO FK into users/work_history (§17.3).
 */
export interface OfficialResponder {
  userId: string;
  workHistoryId: string;
  displayName: string;
  agencyName: string | null;
}

/**
 * CitizenOfficialResponseService — the OFFICIAL-RESPONSE loop (C4, plan D12).
 *
 * An INTERNAL staff member (gated upstream by JwtAuthGuard + the `respond`
 * grant guard) posts an official answer to a citizen post; the post author is
 * notified and the response becomes a public read.
 *
 * §17.3 isolation: touches ONLY `citizen_*` tables. The responder is stored as
 * PLAIN uuids + SNAPSHOT strings — NO FK into `users` / `work_history`. Audit
 * goes EXCLUSIVELY to `citizen_audit_logs` with `actorKind = 'internal'` —
 * NEVER `tracking_status`. Official response is ADVISORY (§17.2): no project is
 * created, no workflow status changes.
 */
@Injectable()
export class CitizenOfficialResponseService {
  constructor(
    @InjectRepository(CitizenOfficialResponse)
    private readonly responseRepo: Repository<CitizenOfficialResponse>,
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    private readonly notificationService: CitizenNotificationService,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // WRITE
  // ---------------------------------------------------------------------------

  /**
   * Post an official response to a visible post. Inserts the response, notifies
   * the post author (no citizen actor), and writes an `internal` audit row —
   * all in one transaction. 404 when the post is missing / removed.
   */
  async respond(
    responder: OfficialResponder,
    postId: string,
    body: string,
  ): Promise<OfficialResponseDto> {
    return this.dataSource.transaction(async (em) => {
      const post = await em.getRepository(CitizenPost).findOne({
        where: { id: postId, moderationState: 'visible', deletedAt: IsNull() },
      });
      if (!post) {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }

      const response = em.getRepository(CitizenOfficialResponse).create({
        postId,
        responderWorkHistoryId: responder.workHistoryId,
        responderUserId: responder.userId,
        responderDisplayName: responder.displayName,
        responderAgencyName: responder.agencyName ?? null,
        body,
        // W-G2: a new response always starts in `received`.
        status: 'received',
        statusUpdatedAt: new Date(),
      });
      const saved = await em.getRepository(CitizenOfficialResponse).save(response);

      // Notify the post author — actor is NULL (internal), kind official_response.
      await this.notificationService.notifyOnOfficialResponse(em, post, saved.id);

      await this.writeAudit(
        em,
        responder.workHistoryId,
        'official-response.create',
        'official_response',
        saved.id,
        { postId },
      );

      return this.toOfficialResponseDto(saved);
    });
  }

  /**
   * W-G2: advance an official response's issue-handling status. Authority is the
   * SAME C4 `respond` grant the create path uses (gated upstream by
   * `CitizenRespondGrantGuard` — staff with official-response authority per §4.1,
   * NOT ownership). The responder identity is resolved from the JWT context.
   *
   * Forward-or-same only (`received → in_progress → resolved`): a backward move
   * → `400 OFFICIAL_RESPONSE_STATUS_INVALID`; a same-status move is a NO-OP
   * (returns the unchanged DTO, writes no audit, sends no duplicate notify).
   * On a real advance: update `status` + `status_updated_at`, write an isolated
   * `internal` audit row, and notify the post author (reusing the C4
   * `official_response` notification kind). All in one transaction. §17.2
   * advisory — no project / tracking_status mutation.
   */
  async updateStatus(
    responder: OfficialResponder,
    responseId: string,
    status: OfficialResponseStatus,
  ): Promise<OfficialResponseDto> {
    return this.dataSource.transaction(async (em) => {
      const responseRepo = em.getRepository(CitizenOfficialResponse);
      const response = await responseRepo.findOne({
        where: { id: responseId, deletedAt: IsNull() },
      });
      if (!response) {
        throw new NotFoundException('CITIZEN_OFFICIAL_RESPONSE_NOT_FOUND');
      }

      const fromRank = STATUS_ORDER.indexOf(
        response.status as OfficialResponseStatus,
      );
      const toRank = STATUS_ORDER.indexOf(status);
      // A stored status outside the known set (fromRank === -1) is a data bug;
      // treat any non-forward move (including that) as invalid.
      if (toRank < fromRank || fromRank === -1) {
        throw new BadRequestException('OFFICIAL_RESPONSE_STATUS_INVALID');
      }

      // Same-status → idempotent NO-OP: no write, no dup notify, no audit.
      if (toRank === fromRank) {
        return this.toOfficialResponseDto(response);
      }

      const now = new Date();
      // Targeted column update — never a full-entity save() (avoids writing back
      // a stale snapshot under concurrency).
      await responseRepo.update(
        { id: responseId },
        { status, statusUpdatedAt: now },
      );
      response.status = status;
      response.statusUpdatedAt = now;

      // Notify the post author — only when the post is still live (a removed /
      // deleted post has no author inbox to surface this in).
      const post = await em.getRepository(CitizenPost).findOne({
        where: {
          id: response.postId,
          moderationState: 'visible',
          deletedAt: IsNull(),
        },
      });
      if (post) {
        await this.notificationService.notifyOnOfficialResponseStatus(
          em,
          post,
          response.id,
        );
      }

      await this.writeAudit(
        em,
        responder.workHistoryId,
        'official-response.status',
        'official_response',
        response.id,
        { postId: response.postId, from: STATUS_ORDER[fromRank], to: status },
      );

      return this.toOfficialResponseDto(response);
    });
  }

  // ---------------------------------------------------------------------------
  // READ (public — only for a visible, non-deleted post)
  // ---------------------------------------------------------------------------

  /**
   * The visible post's official responses, oldest-first. Returns an empty list
   * when the post is missing / removed (the post-detail read already 404s the
   * missing post; this is a defensive guard for direct callers).
   */
  async listForPost(postId: string): Promise<OfficialResponseDto[]> {
    const post = await this.postRepo.findOne({
      where: { id: postId, moderationState: 'visible', deletedAt: IsNull() },
    });
    if (!post) {
      return [];
    }
    const rows = await this.responseRepo.find({
      where: { postId, deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => this.toOfficialResponseDto(r));
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

  /** PII guard: expose ONLY the snapshot name/agency — never the plain uuids. */
  private toOfficialResponseDto(r: CitizenOfficialResponse): OfficialResponseDto {
    return {
      id: r.id,
      body: r.body,
      responderDisplayName: r.responderDisplayName,
      responderAgencyName: r.responderAgencyName ?? null,
      createdAt: (r.createdAt ?? new Date()).toISOString(),
      // W-G2: issue-handling status lifecycle (advisory display state, §17.2).
      status: r.status ?? 'received',
      statusUpdatedAt: r.statusUpdatedAt
        ? r.statusUpdatedAt.toISOString()
        : null,
    };
  }
}
