/**
 * line-user-binding.service.ts — Wave 86 W86-BE-LINE-AI-BRIDGE.
 *
 * Read/write helpers around `line_user_bindings`. Centralizes the
 * common queries that the webhook router and AI bridge both need so
 * neither has to know the soft-unlink-vs-active filter shape directly.
 *
 * CLAUDE.md references:
 *   - §17.3 Audit separation. Binding mutations NEVER touch
 *     `tracking_status`. The soft-unlink pattern (`unlinkedAt`) is the
 *     ONLY supported "delete" — hard deletes happen exclusively via the
 *     `users` FK CASCADE on PDPA erasure.
 *   - §17.11 No role exemption. Active-binding uniqueness is integrity,
 *     not permission. The unique partial index on
 *     `(line_user_id) WHERE unlinked_at IS NULL` is the structural
 *     guarantee; this service does not (and cannot) bypass it.
 *   - §4 Ownership. The binding's `userId` is the Project Bank user;
 *     downstream consumers MUST resolve current WorkHistory via the
 *     standard repository, NEVER via `userId` alone.
 *
 * Logging discipline (W83):
 *   - NEVER log `lineUserId` (PDPA personal data) or replyTokens.
 *   - Operations log structured outcomes only — counts and booleans.
 */

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { LineUserBinding } from './entities/line-user-binding.entity';
// W97-API-FORCE-UNLINK — audit row for super-admin force-unlink. Entity
// class is owned by W97-API-BINDINGS (parallel task) and lives at the
// path below; this service only consumes it. Per §17.3 the audit table
// has NO FK into project tables.
import { LineBindingAdminAction } from 'src/notifications/line/entities/line-binding-admin-action.entity';

@Injectable()
export class LineUserBindingService {
  private readonly logger = new Logger(LineUserBindingService.name);

  constructor(
    @InjectRepository(LineUserBinding)
    private readonly bindings: Repository<LineUserBinding>,
  ) {}

  /**
   * Resolve a LINE userId to its single ACTIVE binding row, or `null`
   * if none exists. "Active" means `unlinkedAt IS NULL` — soft-unlinked
   * historical rows are intentionally excluded.
   *
   * Uses `idx_line_user_bindings_active_unique` (UNIQUE partial index
   * created in W86CreateLineUserBindings1777680000000) for an O(log N)
   * indexed read on the LINE userId.
   */
  async findActive(lineUserId: string): Promise<LineUserBinding | null> {
    if (typeof lineUserId !== 'string' || lineUserId.length === 0) {
      return null;
    }
    return this.bindings.findOne({
      where: { lineUserId, unlinkedAt: IsNull() },
    });
  }

  /**
   * Bump `lastSeenAt` to `now()` for the active binding identified by
   * `lineUserId`. No-op (returns 0) when no active binding exists.
   *
   * Best-effort — failure is logged but never throws so the AI bridge
   * never aborts mid-turn over a stale activity timestamp.
   */
  async markLastSeen(lineUserId: string): Promise<number> {
    if (typeof lineUserId !== 'string' || lineUserId.length === 0) {
      return 0;
    }
    try {
      const result = await this.bindings.update(
        { lineUserId, unlinkedAt: IsNull() },
        { lastSeenAt: new Date() },
      );
      return result.affected ?? 0;
    } catch (err) {
      // Logged at warn — `lastSeenAt` is operator-facing audit metadata,
      // not a workflow gate. A failed bump is invisible to the user.
      this.logger.warn(
        `binding.lastSeen.failed reason=${this.errorClass(err)} at=${new Date().toISOString()}`,
      );
      return 0;
    }
  }

  /**
   * Persist the LINE-channel conversation id for a LINE userId. Used
   * by the AI bridge after creating the rolling
   * `ai_executive_conversations` row on first message.
   *
   * No-op (returns 0) when no active binding exists.
   *
   * §17.3 — column is plain UUID metadata, NO FK into the AI module.
   */
  async setLineAiConversationId(
    lineUserId: string,
    conversationId: string,
  ): Promise<number> {
    if (typeof lineUserId !== 'string' || lineUserId.length === 0) {
      return 0;
    }
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return 0;
    }
    const result = await this.bindings.update(
      { lineUserId, unlinkedAt: IsNull() },
      { lineAiConversationId: conversationId },
    );
    return result.affected ?? 0;
  }

  /**
   * Soft-unlink the active binding for `lineUserId`. Idempotent —
   * returns 0 when no active binding exists. Per §17.3 we MUST NOT
   * hard-delete; setting `unlinkedAt` preserves the audit trail.
   *
   * Used by the webhook router for the LINE `unfollow` event path
   * (W86-BE-LINE-WEBHOOK already implements this inline; this method
   * exists so future call sites can route through the service layer
   * uniformly).
   */
  async softUnlinkByLineUserId(lineUserId: string): Promise<number> {
    if (typeof lineUserId !== 'string' || lineUserId.length === 0) {
      return 0;
    }
    const result = await this.bindings.update(
      { lineUserId, unlinkedAt: IsNull() },
      { unlinkedAt: new Date() },
    );
    const affected = result.affected ?? 0;
    this.logger.log(
      `binding.softunlink affected=${affected} at=${new Date().toISOString()}`,
    );
    return affected;
  }

  /**
   * W97-API-FORCE-UNLINK — super-admin force-unlink of a LINE binding.
   *
   * Soft-unlink only (NEVER hard-deletes) so the audit row + binding
   * row both survive for forensics. Idempotency is enforced at the DB
   * level via `WHERE unlinkedAt IS NULL` on the UPDATE — a 0-row affect
   * count means "already unlinked" and produces a 409.
   *
   * Source of truth: docs/tasks/wave97/W97-API-FORCE-UNLINK.md §3.
   *
   * Order of checks (§7 of the spec):
   *   1. Binding row must exist (404 otherwise).
   *   2. Self-unlink guard — when `binding.userId === actor.userId`,
   *      require `acknowledgeSelfUnlink === true` (Q12.5).
   *   3. Already-unlinked guard — `unlinkedAt IS NOT NULL` → 409.
   *   4. Race-safe UPDATE with `WHERE unlinkedAt IS NULL`.
   *   5. Audit INSERT in the same transaction.
   *
   * §12 — NEVER writes `tracking_status`. §17.3 — audit row goes to
   * `line_binding_admin_actions`, not into any project table. §17.11 —
   * super-admin authority is the gate, but the audit write is mandatory
   * (caller throws if the audit insert fails). §4.1 — this is governance,
   * not workflow authority; status / responsibleAgency / createdBy are
   * untouched.
   *
   * Returns the audit row id + the unlink timestamp so the caller can
   * relay them to the email pipeline + the HTTP response. The caller
   * (controller) is responsible for the post-transaction email send.
   */
  async forceUnlinkByAdmin(args: {
    bindingId: string;
    actorUserId: string;
    actorWorkHistoryId?: string | null;
    reasonCategory:
      | 'left-org'
      | 'abuse-report'
      | 'cross-binding-deadlock'
      | 'user-request'
      | 'other';
    reason: string;
    acknowledgeSelfUnlink?: boolean;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<{
    bindingId: string;
    targetUserId: string;
    unlinkedAt: Date;
    auditId: string;
  }> {
    const manager = this.bindings.manager;
    return manager.transaction(async (tx) => {
      const bindingRepo = tx.getRepository(LineUserBinding);
      const auditRepo = tx.getRepository(LineBindingAdminAction);

      // Row-lock so two concurrent super-admins do not race each other
      // into a duplicate audit row + the same UPDATE losing the race.
      const binding = await bindingRepo
        .createQueryBuilder('b')
        .setLock('pessimistic_write')
        .where('b.id = :id', { id: args.bindingId })
        .getOne();

      if (!binding) {
        throw new NotFoundException('ไม่พบรายการการเชื่อมต่อ LINE นี้');
      }

      // Q12.5 — self-unlink protection. Compare against the binding's
      // userId (the OWNER of the LINE link), not the actor's role.
      // Super-admin acting on their OWN binding still needs the explicit
      // ack flag so accidental clicks on the dashboard cannot terminate
      // their own LINE link without confirmation.
      if (
        binding.userId === args.actorUserId &&
        args.acknowledgeSelfUnlink !== true
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: 'SELF_UNLINK_REQUIRES_ACKNOWLEDGEMENT',
          message:
            'การยกเลิกการเชื่อมต่อ LINE ของตนเองต้องยืนยันด้วย acknowledgeSelfUnlink=true',
        });
      }

      if (binding.unlinkedAt !== null) {
        throw new ConflictException({
          statusCode: 409,
          code: 'BINDING_ALREADY_UNLINKED',
          message: 'รายการนี้ถูกยกเลิกการเชื่อมต่อไปแล้ว',
        });
      }

      // Race-safe UPDATE — `WHERE unlinkedAt IS NULL` is the optimistic
      // precondition. If a concurrent self-unlink slipped through after
      // the SELECT but before our UPDATE, affected=0 and we surface 409.
      const now = new Date();
      const updateResult = await bindingRepo
        .createQueryBuilder()
        .update(LineUserBinding)
        .set({ unlinkedAt: now })
        .where('id = :id AND unlinked_at IS NULL', { id: binding.id })
        .execute();

      if ((updateResult.affected ?? 0) === 0) {
        throw new ConflictException({
          statusCode: 409,
          code: 'BINDING_ALREADY_UNLINKED',
          message: 'รายการนี้ถูกยกเลิกการเชื่อมต่อไปแล้ว',
        });
      }

      // W97-MIGRATION §3 — `line_binding_admin_actions` has no
      // `reason_category` column; encode as a `[category]` prefix on
      // `reason`. The CHECK constraint on `reason` allows 12..200 chars;
      // the prefix adds <= ~28 chars which keeps the combined length
      // within a comfortable `text` column.
      const encodedReason = `[${args.reasonCategory}] ${args.reason}`;

      const audit = auditRepo.create({
        action: 'force-unlink',
        actorUserId: args.actorUserId,
        actorWorkHistoryId: args.actorWorkHistoryId ?? null,
        targetBindingId: binding.id,
        targetUserId: binding.userId,
        reason: encodedReason,
        requestIp: args.requestIp ?? null,
        requestUserAgent: args.requestUserAgent ?? null,
      });
      const savedAudit = await auditRepo.save(audit);

      // W83 — log binding id only, never the lineUserId. We also avoid
      // logging the operator-supplied reason text (privacy + safety).
      this.logger.log(
        `binding.forceUnlink bindingId=${binding.id} category=${args.reasonCategory} actor=${args.actorUserId} at=${now.toISOString()}`,
      );

      return {
        bindingId: binding.id,
        targetUserId: binding.userId,
        unlinkedAt: now,
        auditId: savedAudit.id,
      };
    });
  }

  // ---- internals --------------------------------------------------------

  private errorClass(err: unknown): string {
    if (err instanceof Error) return err.name || 'Error';
    return 'Unknown';
  }
}
