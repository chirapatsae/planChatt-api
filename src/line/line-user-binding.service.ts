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

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { LineUserBinding } from './entities/line-user-binding.entity';

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

  // ---- internals --------------------------------------------------------

  private errorClass(err: unknown): string {
    if (err instanceof Error) return err.name || 'Error';
    return 'Unknown';
  }
}
