import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { SUPER_ADMIN_ONLY } from 'src/auth/role-groups';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';

import { AiKnowledgeHubService } from './ai-knowledge-hub.service';
import { CreateKnowledgeEntryDto } from './dto/create-knowledge-entry.dto';
import {
  KnowledgeEntryDeleteResponseDto,
  KnowledgeEntryDto,
  KnowledgeEntryListResponseDto,
  KnowledgeEntryRevisionDto,
  ListKnowledgeEntriesQueryDto,
} from './dto/list-knowledge-entry.dto';
import { KnowledgeMapResponseDto } from './dto/knowledge-map.dto';
import {
  SearchPreviewDto,
  SearchPreviewResponseDto,
} from './dto/search-preview.dto';
import { UpdateKnowledgeEntryDto } from './dto/update-knowledge-entry.dto';

/**
 * AiKnowledgeHubController — Wave wave-ai-knowledge-hub BE-01 + BE-02
 * (2026-06-12).
 *
 * CLAUDE.md references:
 *   - §17.15.6 — `GET /v1/ai-knowledge-hub/map` is a zero-write read
 *     aggregator in the §18.13 discipline. (2026-06-16: the entire
 *     user-facing knowledge hub was narrowed to super-admin only per
 *     user direction; supersedes the prior EXEC_READ / ADMIN_OR_ABOVE
 *     audience and the Q6-LOCKED EXEC_READ read audience.)
 *   - §17.8 — every endpoint here is NON-AI: no quota guard, no
 *     cooldown guard, no §17.8 endpoint key. This carve-out is
 *     deliberate and mirrors the chat controller's `GET /quota`
 *     precedent (`ai-executive-chat.controller.ts:230`).
 *   - §17.2 — payloads are advisory display/authoring data; nothing
 *     here gates any workflow transition.
 *   - §17.3 — BE-02 mutations audit via `ai_knowledge_audit_logs`
 *     ONLY (KnowledgeAuditService); NEVER TrackingStatus.
 *   - §17.11 — no role exemption; the guard chain has no bypass path.
 *
 * Guard chain (order matters — mirrors the chat controller canon:
 * cheap token-claim role check BEFORE the live workStatus DB read):
 *   JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard
 *
 * Role matrix (2026-06-16: narrowed to super-admin only per user
 * direction; supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience):
 *   - reads (`map`, list, detail)      → SUPER_ADMIN_ONLY
 *   - revision history                 → SUPER_ADMIN_ONLY
 *   - create / patch / publish /
 *     archive / soft-delete            → SUPER_ADMIN_ONLY
 *
 * Only super-admin callers reach any endpoint; the service still
 * scopes `published`-only visibility and 404s draft/archived detail
 * reads (existence-hiding) for non-author roles where applicable.
 */
@Controller({
  path: 'ai-knowledge-hub',
  version: '1',
})
export class AiKnowledgeHubController {
  constructor(private readonly knowledgeHubService: AiKnowledgeHubService) {}

  /**
   * GET /v1/ai-knowledge-hub/map
   *
   * Full mind-map dataset for FE-01: 7 derived domains projected from
   * `EXECUTIVE_TOOL_REGISTRY` metadata + curated domains, live
   * curated/external counts, freshness, and the Q1 coverage-gap nodes.
   * ZERO writes (§17.15.6 / §18.13 condition 2). No PII, no staging
   * content, no secrets in the payload.
   *
   * (2026-06-16: narrowed to super-admin only per user direction;
   * supersedes the prior EXEC_READ / ADMIN_OR_ABOVE audience.)
   */
  @Get('map')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async getKnowledgeMap(): Promise<KnowledgeMapResponseDto> {
    return this.knowledgeHubService.getKnowledgeMap();
  }

  /**
   * POST /v1/ai-knowledge-hub/search-preview
   *
   * Deterministic, ZERO-COST "retrieval test" — lets an admin confirm,
   * right after publishing an entry, that the AI will actually find it
   * WITHOUT spending LLM tokens. It calls the SAME ranking the
   * `searchKnowledgeBase` tool uses, so a pass here guarantees the entry
   * is in the candidate set the LLM sees.
   *
   * Role gate: super-admin ONLY (`@Roles(...SUPER_ADMIN_ONLY)`) —
   * testing is an AUTHORING action. There is NO super-admin bypass
   * branch (§17.11); the guard chain is the only gate. (2026-06-16:
   * narrowed to super-admin only per user direction; supersedes the
   * prior EXEC_READ / ADMIN_OR_ABOVE audience.)
   *
   * §17.8 carve-out (mirrors the `GET /map` rationale above + the chat
   * controller's `GET /quota` precedent): this is a NON-AI deterministic
   * DB read — it runs NO LLM call and spends NO tokens — so it carries
   * NO cooldown guard, NO quota guard, and registers NO §17.8 endpoint
   * key. ZERO writes (§18.13 discipline): one ranking read, no
   * `tracking_status` insert, no `ai_*` write, no notification. Advisory
   * only (§17.2) — the result gates nothing.
   */
  @Post('search-preview')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async searchPreview(
    @Body() dto: SearchPreviewDto,
  ): Promise<SearchPreviewResponseDto> {
    return this.knowledgeHubService.searchPreview(dto);
  }

  // ──────────────────────────────────────────────────────────────────
  // BE-02 — curated knowledge entries
  // ──────────────────────────────────────────────────────────────────

  /**
   * GET /v1/ai-knowledge-hub/entries
   *
   * Paginated list (super-admin only; limit hard-capped at 100). The
   * service still scopes `published`-only visibility for non-author
   * roles. ZERO-WRITE. (2026-06-16: narrowed to super-admin only per
   * user direction; supersedes the prior EXEC_READ / ADMIN_OR_ABOVE
   * audience.)
   */
  @Get('entries')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async listEntries(
    @Query() query: ListKnowledgeEntriesQueryDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeEntryListResponseDto> {
    return this.knowledgeHubService.listEntries(query, req.user.role);
  }

  /**
   * GET /v1/ai-knowledge-hub/entries/:id
   *
   * Single entry (super-admin only). The service still scopes
   * `published`-only visibility for non-author roles (draft / archived
   * answer 404, existence-hiding). ZERO-WRITE. (2026-06-16: narrowed to
   * super-admin only per user direction; supersedes the prior EXEC_READ
   * / ADMIN_OR_ABOVE audience.)
   */
  @Get('entries/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async getEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeEntryDto> {
    return this.knowledgeHubService.getEntry(id, req.user.role);
  }

  /**
   * GET /v1/ai-knowledge-hub/entries/:id/revisions
   *
   * Immutable revision history, newest first (super-admin only).
   * ZERO-WRITE. (2026-06-16: narrowed to super-admin only per user
   * direction; supersedes the prior EXEC_READ / ADMIN_OR_ABOVE
   * audience.)
   */
  @Get('entries/:id/revisions')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async listEntryRevisions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KnowledgeEntryRevisionDto[]> {
    return this.knowledgeHubService.listEntryRevisions(id);
  }

  /**
   * POST /v1/ai-knowledge-hub/entries
   *
   * Create a curated draft (super-admin only). Always
   * `origin = 'curated'`, `status = 'draft'`, revision v1; audits
   * `create` (§17.3). (2026-06-16: narrowed to super-admin only per
   * user direction; supersedes the prior EXEC_READ / ADMIN_OR_ABOVE
   * audience.)
   */
  @Post('entries')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async createEntry(
    @Body() dto: CreateKnowledgeEntryDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeEntryDto> {
    return this.knowledgeHubService.createEntry(dto, req.user.userId);
  }

  /**
   * PATCH /v1/ai-knowledge-hub/entries/:id
   *
   * Edit → immutable revision vN+1 + version bump + §17.4 hash
   * recompute (super-admin only). Identical-content PATCH is an
   * idempotent no-op (no revision, no audit). Optimistic concurrency via
   * `dto.currentVersion` → `409 KNOWLEDGE_VERSION_CONFLICT`. (2026-06-16:
   * narrowed to super-admin only per user direction; supersedes the
   * prior EXEC_READ / ADMIN_OR_ABOVE audience.)
   */
  @Patch('entries/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async updateEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKnowledgeEntryDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeEntryDto> {
    return this.knowledgeHubService.updateEntry(id, dto, req.user.userId);
  }

  /**
   * POST /v1/ai-knowledge-hub/entries/:id/publish
   *
   * draft → published (§17.5 explicit human action; only published
   * entries become chat-visible via BE-04). Audits `publish`
   * (super-admin only). (2026-06-16: narrowed to super-admin only per
   * user direction; supersedes the prior EXEC_READ / ADMIN_OR_ABOVE
   * audience.)
   */
  @Post('entries/:id/publish')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async publishEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeEntryDto> {
    return this.knowledgeHubService.publishEntry(id, req.user.userId);
  }

  /**
   * POST /v1/ai-knowledge-hub/entries/:id/archive
   *
   * published → archived (leaves the chat-visible corpus). Audits
   * `archive` (super-admin only). (2026-06-16: narrowed to super-admin
   * only per user direction; supersedes the prior EXEC_READ /
   * ADMIN_OR_ABOVE audience.)
   */
  @Post('entries/:id/archive')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async archiveEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeEntryDto> {
    return this.knowledgeHubService.archiveEntry(id, req.user.userId);
  }

  /**
   * DELETE /v1/ai-knowledge-hub/entries/:id
   *
   * Soft delete (revisions + audit trail preserved). Audits `delete`
   * BEFORE `deletedAt` flips, in the same transaction (super-admin
   * only). (2026-06-16: narrowed to super-admin only per user
   * direction; supersedes the prior EXEC_READ / ADMIN_OR_ABOVE
   * audience.)
   */
  @Delete('entries/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async deleteEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeEntryDeleteResponseDto> {
    return this.knowledgeHubService.deleteEntry(id, req.user.userId);
  }
}
