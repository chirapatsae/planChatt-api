import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
// Wave 44 N3 — cooldown canon (§17.8). Arm on 2xx only.
import { AiCooldownGuard } from 'src/ai/guards/ai-cooldown.guard';
import { AiCooldown } from 'src/ai/decorators/ai-cooldown.decorator';
// Wave 44 / BE-W44-03 — quota guard MUST precede cooldown so 429 does
// not arm the cooldown window.
import { AiQuotaGuard } from 'src/ai-usage-quotas/guards/ai-quota.guard';
import { AiQuotaWeight } from 'src/ai-usage-quotas/decorators/ai-quota-weight.decorator';
// auth-roles-guard-unification BE-04 — executive-scope admission is now
// expressed via the canonical `@Roles(...) + RolesGuard` pair plus the
// `WorkStatusApprovedGuard` for the §2 live-read. The bespoke
// `ExecutiveRoleGuard` is retired in this wave.
import { RolesGuard } from 'src/auth/roles.guard';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { Roles } from 'src/auth/roles.decorator';
import { EXEC_READ } from 'src/auth/role-groups';
import { PostChatMessageDto } from './dto/send-message.dto';
import {
  ChatConversationSummaryDto,
  ChatMessageDto,
} from './dto/conversation.dto';
// PRIV-W44-01 — PDPA right-to-access / right-to-erasure service.
import { AiExecutiveChatPdpaService } from './ai-executive-chat-pdpa.service';
// BE-W44-02 — SSE tool-call loop service.
import { AiExecutiveChatService } from './ai-executive-chat.service';
// Wave 44 QA C1 — /quota endpoint reads per-user quota + org cap cache.
import { AiUsageQuotasService } from 'src/ai-usage-quotas/ai-usage-quotas.service';
import { QuotaOrgCapService } from 'src/ai-usage-quotas/quota-org-cap.service';

/**
 * AiExecutiveChatController — Wave 44 (BE-W44-01 skeleton + PRIV-W44-01).
 *
 * CLAUDE.md references:
 *   - §4.1 / §17.2 — advisory; chat never gates workflow transitions.
 *   - §17.3 — no project/plan/tracking FK touched here.
 *   - §17.4 — snapshot-only read semantics applied at service layer.
 *   - §17.8 — cooldown canon (6 s per conversation).
 *   - §17.9 — DTO length cap (2000 chars) belt-and-braces.
 *   - §17.11 — no role exemption on quota / cooldown.
 *
 * Guard chain (order matters):
 *   JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard → AiQuotaGuard → AiCooldownGuard
 *
 * (Pre-BE-04 the role + workStatus pair was a single bespoke
 * `ExecutiveRoleGuard`. Per auth-roles-guard-unification §7.6 / BE-01
 * §6 the canonical chain places the cheap token-claim role check
 * before the live workStatus DB read. EXEC_READ = staff + admin +
 * super-admin + c-level matches the prior `ALLOWED_ROLES` exactly.)
 *
 * BE-W44-01 skeleton returns 501 for `POST /messages`. BE-W44-02 owns
 * SSE streaming + the LLM tool-call loop. `GET /conversations` and
 * `GET /conversations/:id/messages` return empty arrays — shape-only
 * contract for FE-W44-01 to build against.
 *
 * PRIV-W44-01 + Wave 44 QA C1 endpoints:
 *   - DELETE /conversations/:id          — owner delete
 *   - PATCH  /conversations/:id          — owner rename (title only)
 *   - DELETE /conversations               — owner bulk delete (confirm:true)
 *   - POST   /export-my-data             — owner SAR JSON export
 *   - GET    /quota                      — quota snapshot for UI
 *   - DELETE /admin/conversations/:id    — admin override (audit-logged)
 *
 * The admin override uses its own guard stack (JwtAuthGuard only, no
 * RolesGuard / WorkStatusApprovedGuard at the class level for the
 * admin path is intentionally re-evaluated at the service layer — the
 * admin route is open to admin/super-admin, and the service MUST
 * enforce the role check itself). To keep the controller simple we
 * still route through JwtAuthGuard here and delegate full admin-role
 * enforcement to `AiExecutiveChatPdpaService.adminDeleteConversation`.
 */
@Controller({
  path: 'ai/executive-chat',
  version: '1',
})
export class AiExecutiveChatController {
  constructor(
    private readonly pdpaService: AiExecutiveChatPdpaService,
    private readonly chatService: AiExecutiveChatService,
    private readonly quotaService: AiUsageQuotasService,
    private readonly orgCapService: QuotaOrgCapService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // Chat surfaces (BE-W44-01 skeleton — unchanged)
  // Guard chain: JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard
  //   → (quota/cooldown)
  // ─────────────────────────────────────────────────────────────────

  /**
   * POST /v1/ai/executive-chat/messages
   *
   * BE-W44-01 returns 501. BE-W44-02 replaces with SSE stream.
   */
  @Post('messages')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    AiQuotaGuard,
    AiCooldownGuard,
  )
  @Roles(...EXEC_READ)
  @AiQuotaWeight('executive-chat')
  @AiCooldown('executive-chat', 6, 'body.conversationId')
  async sendMessage(
    @Body() body: PostChatMessageDto,
    @Req()
    req: Request & {
      user: JwtPayloadUser;
      aiModelOverride?: string;
    },
    @Res() res: Response,
  ): Promise<void> {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    // `AiQuotaGuard` wrote `req.aiModelOverride` — forward it so the
    // service can honor the 80% auto-downgrade rule on every hop.
    await this.chatService.sendMessage(
      req.user.userId,
      body,
      res,
      req.aiModelOverride,
    );
  }

  /**
   * GET /v1/ai/executive-chat/conversations
   *
   * BE-W46-01 — owner-scoped list of the caller's active
   * conversations ordered by most-recent activity. Soft-deleted rows
   * are excluded. Capped at 200 rows defensively.
   *
   * §17.2 advisory / §17.3 audit separation / §17.11 no role exemption
   * — ownership is derived from the caller's CURRENT WorkHistory at
   * the service layer; no admin bypass.
   */
  @Get('conversations')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...EXEC_READ)
  async listConversations(
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<{ conversations: ChatConversationSummaryDto[] }> {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    const conversations =
      await this.chatService.listConversationsForOwnerByUserId(req.user.userId);
    return { conversations };
  }

  /**
   * GET /v1/ai/executive-chat/conversations/:id/messages
   *
   * BE-W46-01 — chronological message list for a conversation the
   * caller owns. Non-owner and non-existent ids both return
   * `404 CONVERSATION_NOT_FOUND` (enumeration guard). Every returned
   * row carries `isStale: false` per §17.4 snapshot-only.
   */
  @Get('conversations/:id/messages')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...EXEC_READ)
  async listMessages(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<{ messages: ChatMessageDto[] }> {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    const messages = await this.chatService.listMessagesForConversationByUserId(
      id,
      req.user.userId,
    );
    return { messages };
  }

  /**
   * PATCH /v1/ai/executive-chat/conversations/:id
   *
   * Wave 44 QA C1 — FE calls `renameConversation(id, title)` via
   * `api.patch` (executiveAiChat.ts:215-220). Owner-scoped title
   * update; non-owner returns 404 (enumeration guard §17.3).
   */
  @Patch('conversations/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...EXEC_READ)
  async renameConversation(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Body() body: { title?: string },
  ): Promise<{ id: string; title: string }> {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    if (typeof body?.title !== 'string') {
      throw new BadRequestException('TITLE_REQUIRED');
    }
    // §17.9-style defensive hygiene: strip control chars + cap length.
    const stripped = body.title.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (stripped.length === 0) {
      throw new BadRequestException('TITLE_REQUIRED');
    }
    const title = stripped.slice(0, 200);
    return this.pdpaService.renameConversation(req.user.userId, id, title);
  }

  /**
   * GET /v1/ai/executive-chat/quota
   *
   * Wave 44 QA C1 — FE calls `getQuotaSnapshot` (executiveAiChat.ts:
   * 248-257) expecting `{ usedThb, remainingThb, capThb, resetAt?,
   * orgConsumedThb?, orgCapThb? }`. This endpoint READS quota state;
   * it MUST NOT itself consume quota or trigger cooldown, so the
   * guard chain is trimmed to `JwtAuthGuard → RolesGuard →
   * WorkStatusApprovedGuard` (no `AiQuotaGuard` / `AiCooldownGuard`).
   * Task explicitly documents this carve-out.
   *
   * §17.11 — this read path is NOT a workflow transition; returning
   * null-safe zeroes on missing data is advisory-compliant.
   */
  @Get('quota')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...EXEC_READ)
  async getQuota(@Req() req: Request & { user: JwtPayloadUser }): Promise<{
    usedThb: number;
    remainingThb: number;
    capThb: number;
    resetAt: string | null;
    orgConsumedThb: number;
    orgCapThb: number;
  }> {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    const snap = await this.quotaService.getQuotaSnapshotForUi(req.user.userId);
    const orgCapThb = this.orgCapService.getOrgCapThb();
    const orgConsumedThb = await this.orgCapService.getOrgMonthlyConsumedThb();
    return {
      usedThb: snap?.usedThb ?? 0,
      remainingThb: snap?.remainingThb ?? 0,
      capThb: snap?.limitThb ?? 0,
      resetAt: snap?.periodEnd ?? null,
      orgConsumedThb,
      orgCapThb,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // PRIV-W44-01 — PDPA owner endpoints
  //
  // Owner delete, bulk delete, and SAR export. Each owner path
  // resolves `currentWorkHistory` from `req.user.userId` at the
  // service layer — §4 ownership source of truth.
  // ─────────────────────────────────────────────────────────────────

  /**
   * DELETE /v1/ai/executive-chat/conversations/:id
   *
   * Owner-scoped soft-delete. Non-owner returns 404 (enumeration
   * guard). Cascades to messages via explicit soft-delete.
   */
  @Delete('conversations/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...EXEC_READ)
  async deleteConversation(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<{ id: string; deletedMessages: number }> {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    return this.pdpaService.deleteOwnConversation(id, req.user.userId);
  }

  /**
   * POST /v1/ai/executive-chat/export-my-data
   *
   * Wave 44 QA C1 — FE calls `api.post('/export-my-data', {}, {
   * responseType: 'blob' })` (executiveAiChat.ts:230-237). The
   * previous `GET /my-export` shape did not match. POST is also
   * appropriate for a side-effect-producing SAR export (audit log
   * on the AI-quota side may tick).
   *
   * PDPA subject-access — returns all conversations + messages owned
   * by the caller (including soft-deleted rows that are still within
   * the retention window) as a JSON document. FE sets
   * `responseType: 'blob'` — Nest will serialize the JSON response
   * body and the browser turns it into a Blob transparently.
   */
  @Post('export-my-data')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...EXEC_READ)
  async exportMyData(@Req() req: Request & { user: JwtPayloadUser }) {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    return this.pdpaService.exportOwnData(req.user.userId);
  }

  /**
   * DELETE /v1/ai/executive-chat/conversations
   *
   * Wave 44 QA C1 — FE calls `api.delete('/conversations', { data:
   * { confirm: true } })` for the bulk-delete surface
   * (executiveAiChat.ts:226-228). Previously mounted at `/my-data`.
   *
   * Bulk soft-delete of ALL of the caller's conversations. Requires
   * explicit `{ confirm: true }` in the body to pass the cooling-off
   * check — FE MUST show the PDPA confirmation banner first.
   *
   * NOTE: route-order matters — this handler lives BEFORE
   * `@Delete('conversations/:id')` in Nest's matcher, but the `:id`
   * pattern requires a UUID segment so a bare `/conversations`
   * DELETE lands here cleanly.
   */
  @Delete('conversations')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...EXEC_READ)
  async deleteAllConversations(
    @Req() req: Request & { user: JwtPayloadUser },
    @Body() body: { confirm?: boolean },
  ): Promise<{ conversationsDeleted: number; messagesDeleted: number }> {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    return this.pdpaService.deleteAllOwnData(
      req.user.userId,
      Boolean(body?.confirm),
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // PRIV-W44-01 — PDPA admin override
  //
  // Admin / super-admin only. Role enforcement lives at the service
  // layer (not the canonical `RolesGuard` — the EXEC_READ group
  // accepts `staff` and `c-level` which we do NOT want here). Audit
  // row written to `ai_usage_logs` on every successful delete per
  // §17.11.
  // ─────────────────────────────────────────────────────────────────

  /**
   * DELETE /v1/ai/admin/conversations/:id
   *
   * Note: path is mounted at `ai/executive-chat/admin/conversations/:id`
   * via controller base path. A separate `ai/admin/...` namespace can
   * be introduced later if required; the functional contract is
   * identical.
   */
  @Delete('admin/conversations/:id')
  @UseGuards(JwtAuthGuard)
  async adminDeleteConversation(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Body() body: { reason?: string } = {},
  ): Promise<{
    id: string;
    ownerWorkHistoryId: string;
    deletedMessages: number;
  }> {
    if (!req.user?.userId) throw new UnauthorizedException('UNAUTHENTICATED');
    return this.pdpaService.adminDeleteConversation(
      id,
      req.user.userId,
      body?.reason,
    );
  }
}
