import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AiKnowledgeSource } from '../entities/ai-knowledge-source.entity';
import { KnowledgeSourceService } from '../services/knowledge-source.service';

/** Header carrying the per-source API key (task §3.2). */
export const INGEST_API_KEY_HEADER = 'x-pbk-api-key';

/** Request shape after the guard admits a caller. */
export interface KnowledgeIngestRequest {
  params?: { sourceKey?: string };
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  knowledgeSource?: AiKnowledgeSource;
}

/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * KnowledgeSourceApiKeyGuard — the ONLY gate on
 * `POST /v1/ai-knowledge-hub/ingest/:sourceKey`.
 *
 * Security contract (CLAUDE.md §17.15.5; report §6.1 STRIDE-S/E):
 *   - authenticates by `X-PBK-API-KEY` ONLY — NO JwtAuthGuard, NO
 *     session, NO role context. A valid key grants exactly one
 *     capability: writing a row into the quarantine staging table.
 *     The ingest path can never reach app-level authority because no
 *     app identity is ever attached to the request.
 *   - prefix lookup + argon2 constant-time hash compare + timing-
 *     equalized failure path live in
 *     `KnowledgeSourceService.authenticateForIngest`.
 *   - forged key → 401; valid key on a non-active (pending / suspended
 *     / revoked) source → 403. Either way the request NEVER touches
 *     staging (acceptance §6) — the guard throws before the controller
 *     body runs.
 *
 * On success the matched source row is attached as
 * `request.knowledgeSource` so the controller/service never re-resolve
 * it (single authentication, single source of truth per request).
 */
@Injectable()
export class KnowledgeSourceApiKeyGuard implements CanActivate {
  constructor(private readonly knowledgeSourceService: KnowledgeSourceService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<KnowledgeIngestRequest>();

    const headerValue = request.headers[INGEST_API_KEY_HEADER];
    const rawKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    request.knowledgeSource =
      await this.knowledgeSourceService.authenticateForIngest(
        request.params?.sourceKey,
        rawKey,
      );
    return true;
  }
}
