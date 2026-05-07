import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AiUsageLog } from 'src/ai-usage-logs/entities/ai-usage-log.entity';
import { AiExecutiveConversation } from './entities/ai-executive-conversation.entity';
import { AiExecutiveMessage } from './entities/ai-executive-message.entity';

/**
 * PRIV-W44-01 — PDPA right-to-access + right-to-erasure service for
 * executive chat history.
 *
 * Responsibilities:
 *   1. Per-conversation soft-delete (owner-scoped).
 *   2. Bulk soft-delete of ALL of the caller's conversations.
 *   3. Subject-access-request JSON export of the caller's history.
 *   4. Admin-initiated override delete (super-admin / admin only).
 *
 * CLAUDE.md references:
 *   - §4 Ownership — every owner action resolves `currentWorkHistory`
 *     from the authenticated user and matches against
 *     `AiExecutiveConversation.ownerWorkHistoryId`. `userId` alone is
 *     NEVER sufficient (WorkHistory is the integrity key).
 *   - §17.3 Audit separation — this service touches `ai_*` tables
 *     only. The admin-delete path writes an audit row into
 *     `ai_usage_logs`; no `tracking_status` row is created.
 *   - §17.11 No role exemption — owner-scope deletions MUST succeed
 *     for any valid owner, and the admin override requires an
 *     explicit role gate. Neither path can bypass the audit write.
 */
@Injectable()
export class AiExecutiveChatPdpaService {
  private readonly logger = new Logger(AiExecutiveChatPdpaService.name);

  private static readonly ADMIN_ROLES = new Set(['admin', 'super-admin']);

  constructor(
    @InjectRepository(AiExecutiveConversation)
    private readonly conversationRepo: Repository<AiExecutiveConversation>,
    @InjectRepository(AiExecutiveMessage)
    private readonly messageRepo: Repository<AiExecutiveMessage>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @InjectRepository(AiUsageLog)
    private readonly aiUsageLogRepo: Repository<AiUsageLog>,
  ) {}

  // ───────────────────────────────────────────────────────────────
  // Internal helpers
  // ───────────────────────────────────────────────────────────────

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

  private async resolveAdminWorkHistory(userId: string): Promise<WorkHistory> {
    const wh = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus', 'role'],
    });
    if (!wh) throw new ForbiddenException('WORK_HISTORY_NOT_FOUND');
    const role = wh.role?.name?.toLowerCase() ?? '';
    const status = wh.workStatus?.name?.toLowerCase() ?? '';
    if (status !== 'approved')
      throw new ForbiddenException('WORK_STATUS_NOT_APPROVED');
    if (!AiExecutiveChatPdpaService.ADMIN_ROLES.has(role)) {
      throw new ForbiddenException('ADMIN_ROLE_REQUIRED');
    }
    return wh;
  }

  // ───────────────────────────────────────────────────────────────
  // Owner — single conversation soft-delete
  // ───────────────────────────────────────────────────────────────

  /**
   * Owner-scoped soft-delete of a single conversation plus its
   * messages. Mismatched owner returns 404 (not 403) to prevent
   * enumeration, mirroring the `ai_usage_logs` detail-read discipline.
   */
  async deleteOwnConversation(
    conversationId: string,
    userId: string,
  ): Promise<{ id: string; deletedMessages: number }> {
    const ownerWorkHistoryId = await this.resolveOwnerWorkHistoryId(userId);

    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, deletedAt: IsNull() },
    });
    if (!conversation) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    if (conversation.ownerWorkHistoryId !== ownerWorkHistoryId) {
      // 404 (not 403) — prevents cross-owner ID enumeration.
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    const msgResult = await this.messageRepo.softDelete({
      conversationId: conversation.id,
    });
    await this.conversationRepo.softDelete(conversation.id);

    this.logger.log(
      `[pdpa] owner-delete-conversation id=${conversation.id} msgs=${msgResult.affected ?? 0} ownerWorkHistoryId=${ownerWorkHistoryId}`,
    );

    return {
      id: conversation.id,
      deletedMessages: msgResult.affected ?? 0,
    };
  }

  // ───────────────────────────────────────────────────────────────
  // Owner — rename conversation (Wave 44 QA C1)
  // ───────────────────────────────────────────────────────────────

  /**
   * Owner-scoped rename of a conversation. Matches the ownership
   * discipline used by `deleteOwnConversation`:
   *   - non-owner → 404 (enumeration guard)
   *   - missing row → 404
   *   - caller MUST have `workStatus = approved`
   *
   * Title is pre-sanitised at the controller layer (control chars
   * stripped, trimmed, capped at 200 chars). This method performs
   * defence-in-depth re-checks and persists.
   */
  async renameConversation(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<{ id: string; title: string }> {
    const ownerWorkHistoryId = await this.resolveOwnerWorkHistoryId(userId);

    const safeTitle = (title ?? '')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim()
      .slice(0, 200);
    if (safeTitle.length === 0) {
      throw new BadRequestException('TITLE_REQUIRED');
    }

    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, deletedAt: IsNull() },
    });
    if (!conversation) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    if (conversation.ownerWorkHistoryId !== ownerWorkHistoryId) {
      // 404 (not 403) — enumeration guard mirrors delete path.
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    conversation.title = safeTitle;
    // Wave 51 BE-W51-01 — manual rename wins over any prior
    // auto-title or placeholder. Setting `titleSource = 'user-rename'`
    // is the compare-and-set gate BE-W51-02 relies on: the auto-title
    // writer only UPDATEs rows where `title_source = 'default-placeholder'`,
    // so flipping this value here permanently opts the conversation
    // out of background auto-titling. §17.11 — integrity, not
    // permission; no role (including super-admin) can demote this
    // back to `'default-placeholder'` or `'llm-auto'`.
    conversation.titleSource = 'user-rename';
    conversation.titleGeneratedAt = new Date();
    await this.conversationRepo.save(conversation);

    this.logger.log(
      `[pdpa] owner-rename-conversation id=${conversation.id} ownerWorkHistoryId=${ownerWorkHistoryId} titleSource=user-rename`,
    );

    return { id: conversation.id, title: safeTitle };
  }

  // ───────────────────────────────────────────────────────────────
  // Owner — bulk soft-delete "all my data"
  // ───────────────────────────────────────────────────────────────

  async deleteAllOwnData(
    userId: string,
    confirmed: boolean,
  ): Promise<{ conversationsDeleted: number; messagesDeleted: number }> {
    // Cooling-off confirm flag — FE MUST pass `{ confirm: true }`
    // after the PDPA confirmation banner is acknowledged.
    if (!confirmed) {
      throw new BadRequestException('CONFIRMATION_REQUIRED');
    }

    const ownerWorkHistoryId = await this.resolveOwnerWorkHistoryId(userId);

    const active = await this.conversationRepo.find({
      where: { ownerWorkHistoryId, deletedAt: IsNull() },
      select: ['id'],
    });

    if (active.length === 0) {
      return { conversationsDeleted: 0, messagesDeleted: 0 };
    }

    const ids = active.map((c) => c.id);
    const msgResult = await this.messageRepo.softDelete({
      conversationId: In(ids),
    });
    const convResult = await this.conversationRepo.softDelete(ids);

    this.logger.log(
      `[pdpa] owner-delete-all ownerWorkHistoryId=${ownerWorkHistoryId} conversations=${convResult.affected ?? 0} messages=${msgResult.affected ?? 0}`,
    );

    return {
      conversationsDeleted: convResult.affected ?? 0,
      messagesDeleted: msgResult.affected ?? 0,
    };
  }

  // ───────────────────────────────────────────────────────────────
  // Owner — SAR JSON export
  // ───────────────────────────────────────────────────────────────

  async exportOwnData(userId: string): Promise<{
    ownerWorkHistoryId: string;
    exportedAt: string;
    conversations: Array<{
      id: string;
      title: string;
      model: string;
      createdAt: Date;
      updatedAt: Date | null;
      deletedAt: Date | null;
      messages: Array<{
        id: string;
        role: string;
        contentText: string | null;
        createdAt: Date;
        tokensIn: number | null;
        tokensOut: number | null;
      }>;
    }>;
  }> {
    const ownerWorkHistoryId = await this.resolveOwnerWorkHistoryId(userId);

    // PDPA subject-access: include soft-deleted rows so the user
    // sees the complete audit picture of what is retained about them
    // up to the retention cutoff.
    const conversations = await this.conversationRepo.find({
      where: { ownerWorkHistoryId },
      withDeleted: true,
      order: { createdAt: 'ASC' },
    });

    if (conversations.length === 0) {
      return {
        ownerWorkHistoryId,
        exportedAt: new Date().toISOString(),
        conversations: [],
      };
    }

    const ids = conversations.map((c) => c.id);
    const messages = await this.messageRepo.find({
      where: { conversationId: In(ids) },
      withDeleted: true,
      order: { createdAt: 'ASC' },
    });
    const byConv = new Map<string, typeof messages>();
    for (const m of messages) {
      const arr = byConv.get(m.conversationId) ?? [];
      arr.push(m);
      byConv.set(m.conversationId, arr);
    }

    return {
      ownerWorkHistoryId,
      exportedAt: new Date().toISOString(),
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        model: c.model,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        deletedAt: c.deletedAt,
        messages: (byConv.get(c.id) ?? []).map((m) => ({
          id: m.id,
          role: m.role,
          contentText: m.contentText,
          createdAt: m.createdAt,
          tokensIn: m.tokensIn,
          tokensOut: m.tokensOut,
        })),
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────
  // Admin — override soft-delete (with audit row)
  // ───────────────────────────────────────────────────────────────

  /**
   * Admin / super-admin may soft-delete ANY conversation. Every
   * successful admin delete MUST write an `ai_usage_logs` audit row
   * so the action is traceable. §17.11 — audit write is non-optional.
   */
  async adminDeleteConversation(
    conversationId: string,
    adminUserId: string,
    reason?: string,
  ): Promise<{
    id: string;
    ownerWorkHistoryId: string;
    deletedMessages: number;
  }> {
    const adminWh = await this.resolveAdminWorkHistory(adminUserId);

    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, deletedAt: IsNull() },
    });
    if (!conversation) throw new NotFoundException('CONVERSATION_NOT_FOUND');

    const msgResult = await this.messageRepo.softDelete({
      conversationId: conversation.id,
    });
    await this.conversationRepo.softDelete(conversation.id);

    // §17.11 — audit row MUST accompany the admin override. Failure
    // to persist the audit is a HARD failure (we throw), because a
    // silent admin delete is a worse compliance outcome than a 500
    // surfaced to the admin.
    try {
      const auditMarker = `PDPA_ADMIN_DELETE:${conversation.id}:owner=${conversation.ownerWorkHistoryId}:by=${adminWh.id}`;
      await this.aiUsageLogRepo.save(
        this.aiUsageLogRepo.create({
          usageType: 'PDPA_ADMIN_DELETE',
          modelName: 'n/a',
          inputTokens: 0,
          outputTokens: 0,
          costBaht: 0,
          endpoint: 'pdpa-admin-delete',
          summaryTh: `ผู้ดูแลระบบลบบทสนทนา executive-chat (id=${conversation.id})${reason ? ' เหตุผล: ' + reason.slice(0, 240) : ''}`,
          actorWorkHistoryId: adminWh.id,
          targetId: conversation.id,
          error: auditMarker,
        }),
      );
    } catch (err) {
      this.logger.error(
        `[pdpa] admin-delete audit write FAILED id=${conversation.id}: ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }

    this.logger.log(
      `[pdpa] admin-delete-conversation id=${conversation.id} by=${adminWh.id} ownerWorkHistoryId=${conversation.ownerWorkHistoryId} msgs=${msgResult.affected ?? 0}`,
    );

    return {
      id: conversation.id,
      ownerWorkHistoryId: conversation.ownerWorkHistoryId,
      deletedMessages: msgResult.affected ?? 0,
    };
  }
}
