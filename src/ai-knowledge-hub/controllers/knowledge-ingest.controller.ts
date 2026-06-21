import {
  Body,
  Controller,
  Get,
  Headers,
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

import {
  IngestResponseDto,
  KnowledgeIngestionDto,
  KnowledgeIngestionListResponseDto,
  ListKnowledgeIngestionsQueryDto,
  PromoteKnowledgeIngestionDto,
  RejectKnowledgeIngestionDto,
} from '../dto/knowledge-ingestion.dto';
import {
  CreateKnowledgeSourceDto,
  KnowledgeSourceCreatedDto,
  KnowledgeSourceDto,
  KnowledgeSourceListResponseDto,
  KnowledgeSourceRotateHmacResponseDto,
  KnowledgeSourceRotateKeyResponseDto,
  UpdateKnowledgeSourceDto,
} from '../dto/knowledge-source.dto';
import { KnowledgeEntryDto } from '../dto/list-knowledge-entry.dto';
import {
  KnowledgeIngestRequest,
  KnowledgeSourceApiKeyGuard,
} from '../guards/knowledge-source-api-key.guard';
import { KnowledgeIngestionService } from '../services/knowledge-ingestion.service';
import { KnowledgeSourceService } from '../services/knowledge-source.service';

/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * KnowledgeIngestController — ALL Phase-2 connector routes (task §3.1–
 * §3.3): source admin console, the API-key ingest endpoint, and the
 * quarantine review surface. Lives beside `AiKnowledgeHubController`
 * (Phase-1 map + entries) under the same `/v1/ai-knowledge-hub` path.
 *
 * TWO disjoint authentication worlds — never mixed on one route:
 *
 *   1. ADMIN routes (`/sources*`, `/ingestions*`) — the standard JWT
 *      chain (JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard) with
 *      `@Roles(...SUPER_ADMIN_ONLY)` (§17.11 — no role exemption, UI
 *      visibility is never access control). (2026-06-16: narrowed to
 *      super-admin only per user direction; supersedes the prior
 *      EXEC_READ / ADMIN_OR_ABOVE audience.)
 *   2. INGEST route (`/ingest/:sourceKey`) — `KnowledgeSourceApiKeyGuard`
 *      ONLY. NO JWT, NO session, NO role context: the API key grants
 *      exactly one capability (staging INSERT). See the least-privilege
 *      note on `KnowledgeIngestionService` (task §3.5).
 *
 * §17.8 — none of these routes registers an AI cooldown key; the ingest
 * 429 is a per-source rate limit whose envelope merely mirrors the
 * §17.8 shape (§17.15.8). §17.3 — zero TrackingStatus writes anywhere
 * behind this controller; audit goes to `ai_knowledge_audit_logs`.
 */
@Controller({
  path: 'ai-knowledge-hub',
  version: '1',
})
export class KnowledgeIngestController {
  constructor(
    private readonly knowledgeSourceService: KnowledgeSourceService,
    private readonly knowledgeIngestionService: KnowledgeIngestionService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // §3.1 — Source admin console (SUPER_ADMIN_ONLY; 2026-06-16: narrowed
  // to super-admin only per user direction; supersedes the prior
  // EXEC_READ / ADMIN_OR_ABOVE audience)
  // ──────────────────────────────────────────────────────────────────

  /** List sources incl. health counters + last_seen_at. ZERO-WRITE. */
  @Get('sources')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async listSources(): Promise<KnowledgeSourceListResponseDto> {
    return this.knowledgeSourceService.listSources();
  }

  /** Source detail incl. health. ZERO-WRITE. */
  @Get('sources/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async getSource(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KnowledgeSourceDto> {
    return this.knowledgeSourceService.getSource(id);
  }

  /**
   * Register a source (`pending_approval`). The response carries the
   * plaintext API key EXACTLY ONCE — it is never persisted, never
   * logged, and unrecoverable afterwards (§17.15.5 hashed credentials).
   */
  @Post('sources')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async createSource(
    @Body() dto: CreateKnowledgeSourceDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeSourceCreatedDto> {
    return this.knowledgeSourceService.createSource(dto, req.user.userId);
  }

  /**
   * 4-eyes activation — approver MUST differ from creator
   * (403 SOURCE_FOUR_EYES_REQUIRED; service-enforced, no role bypass).
   */
  @Post('sources/:id/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async approveSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeSourceDto> {
    return this.knowledgeSourceService.approveSource(id, req.user.userId);
  }

  @Post('sources/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async suspendSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeSourceDto> {
    return this.knowledgeSourceService.suspendSource(id, req.user.userId);
  }

  @Post('sources/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async revokeSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeSourceDto> {
    return this.knowledgeSourceService.revokeSource(id, req.user.userId);
  }

  /** Rotate credential — NEW plaintext key returned ONCE. */
  @Post('sources/:id/rotate-key')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async rotateKey(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeSourceRotateKeyResponseDto> {
    return this.knowledgeSourceService.rotateKey(id, req.user.userId);
  }

  /**
   * Enable (first call) or rotate the optional HMAC body-signature secret
   * — NEW plaintext secret returned ONCE; stored AES-encrypted-at-rest.
   * Sources stay API-key-only until this is called (opt-in).
   */
  @Post('sources/:id/rotate-hmac-secret')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async rotateHmacSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeSourceRotateHmacResponseDto> {
    return this.knowledgeSourceService.rotateHmacSecret(id, req.user.userId);
  }

  /** Disable HMAC — clears the secret, reverting to API-key-only ingest. */
  @Post('sources/:id/disable-hmac-secret')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async disableHmacSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeSourceDto> {
    return this.knowledgeSourceService.disableHmacSecret(id, req.user.userId);
  }

  /** Schema / rate-limit / domain edits — NOT status, NOT credentials. */
  @Patch('sources/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async updateSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKnowledgeSourceDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeSourceDto> {
    return this.knowledgeSourceService.updateSource(id, dto, req.user.userId);
  }

  // ──────────────────────────────────────────────────────────────────
  // §3.2 — Ingest (API-key guard ONLY; no JWT, no session, no role)
  // ──────────────────────────────────────────────────────────────────

  /**
   * POST /v1/ai-knowledge-hub/ingest/:sourceKey
   *
   * Quarantine-only landing (§17.15.5). Writes staging ONLY — never
   * entries, never prompts. Required `X-Idempotency-Key`; duplicate
   * `(source_id, key)` answers 200 with the ORIGINAL row id and
   * `duplicate: true`. The `payload` body parameter is deliberately
   * untyped (`Record<string, unknown>`) so the global ValidationPipe
   * passes it through verbatim — validation happens against the
   * SOURCE's declared schema, not a class DTO.
   */
  @Post('ingest/:sourceKey')
  @HttpCode(HttpStatus.OK)
  @UseGuards(KnowledgeSourceApiKeyGuard)
  async ingest(
    @Body() payload: Record<string, unknown>,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Req() req: KnowledgeIngestRequest,
  ): Promise<IngestResponseDto> {
    return this.knowledgeIngestionService.ingest(
      // Attached by KnowledgeSourceApiKeyGuard — guaranteed present
      // once the guard admits the request.
      req.knowledgeSource!,
      payload,
      idempotencyKey,
      req.ip ?? null,
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // §3.3 — Quarantine review (SUPER_ADMIN_ONLY; 2026-06-16: narrowed to
  // super-admin only per user direction; supersedes the prior EXEC_READ
  // / ADMIN_OR_ABOVE audience)
  // ──────────────────────────────────────────────────────────────────

  /** Paginated staging review list (cap 100). ZERO-WRITE (§18.13). */
  @Get('ingestions')
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async listIngestions(
    @Query() query: ListKnowledgeIngestionsQueryDto,
  ): Promise<KnowledgeIngestionListResponseDto> {
    return this.knowledgeIngestionService.listIngestions(query);
  }

  /**
   * Promote → DRAFT entry (`origin='external'`) via the BE-02 service.
   * 422 INGEST_PII_BLOCKED while PII flags remain on the effective
   * mapped fields (Q4 — categorically forbidden).
   */
  @Post('ingestions/:id/promote')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async promoteIngestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PromoteKnowledgeIngestionDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<{ ingestion: KnowledgeIngestionDto; entry: KnowledgeEntryDto }> {
    return this.knowledgeIngestionService.promote(id, dto, req.user.userId);
  }

  /** Reject a quarantined item (audit `reject`). */
  @Post('ingestions/:id/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  async rejectIngestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectKnowledgeIngestionDto,
    @Req() req: { user: JwtPayloadUser },
  ): Promise<KnowledgeIngestionDto> {
    return this.knowledgeIngestionService.reject(id, dto, req.user.userId);
  }
}
