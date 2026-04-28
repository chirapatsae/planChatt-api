import { Injectable, Logger } from '@nestjs/common';
import { OpenAI } from 'openai';
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionParamsNonStreaming,
  ChatCompletionParamsStreaming,
  LlmClient,
} from './llm-client.interface';

/**
 * PRIV-W44-01 — single OpenAI concrete impl of `LlmClient`.
 *
 * Configuration:
 *   - `OPENAI_API_KEY`      (required) — credential
 *   - `OPENAI_ORG_ID`       (optional) — org scoping for zero-retention
 *                           DPA enforcement (see `docs/ops/openai-dpa.md`)
 *   - `OPENAI_BASE_URL`     (optional) — override (future-proofs
 *                           Azure OpenAI / compatible endpoint swap)
 *   - `OPENAI_ZERO_RETENTION` (optional, default 'true')
 *                           — when `'true'`, the service attaches the
 *                           `OpenAI-Beta: zero-retention=on` header on
 *                           every request. Header support is subject
 *                           to the org-level DPA — if OpenAI does NOT
 *                           accept a per-request header, the org-level
 *                           "zero data retention" setting is the
 *                           enforcement mechanism. See
 *                           `docs/ops/openai-dpa.md` §3 for the
 *                           runbook that keeps these two layers in
 *                           sync.
 *
 * Post-Wave-44 invariant: this is the ONLY direct OpenAI SDK
 * instantiation in `backend/src/`. The grep gate is enforced by
 * QA-W44-01 and documented in `docs/tasks/wave44/PRIV-W44-01.md`.
 */
@Injectable()
export class OpenAILlmClient implements LlmClient {
  readonly providerName = 'openai' as const;

  private readonly logger = new Logger(OpenAILlmClient.name);
  private readonly client: OpenAI;
  private readonly zeroRetentionEnabled: boolean;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    const organization = process.env.OPENAI_ORG_ID || undefined;
    const baseURL = process.env.OPENAI_BASE_URL || undefined;

    // Default ON. Set `OPENAI_ZERO_RETENTION=false` explicitly to
    // opt out (non-prod / debugging). The org-level DPA remains the
    // primary enforcement layer per `docs/ops/openai-dpa.md`.
    this.zeroRetentionEnabled =
      (process.env.OPENAI_ZERO_RETENTION ?? 'true').toLowerCase() !== 'false';

    const defaultHeaders: Record<string, string> = {};
    if (this.zeroRetentionEnabled) {
      // Advisory header — OpenAI currently enforces zero retention at
      // the org level; this header is a belt-and-braces signal for
      // future per-request support and for our own outbound audit
      // log. Safe to send even if the provider ignores it.
      defaultHeaders['OpenAI-Beta'] = 'zero-retention=on';
      defaultHeaders['X-Project-Bank-Zero-Retention'] = '1';
    }

    this.client = new OpenAI({
      apiKey,
      organization,
      baseURL,
      defaultHeaders,
    });

    this.logger.log(
      `[LlmClient] provider=openai orgId=${organization ?? '(none)'} zeroRetention=${this.zeroRetentionEnabled} baseUrl=${baseURL ?? 'default'}`,
    );
  }

  async createChatCompletion(
    params: ChatCompletionParamsNonStreaming,
  ): Promise<ChatCompletion> {
    // The SDK's overload resolves the non-streaming return type when
    // `stream` is not `true`. Callers pass a non-streaming params
    // object (no `stream: true`); we forward it unchanged so the
    // overload resolves to `APIPromise<ChatCompletion>`.
    return this.client.chat.completions.create(params);
  }

  async *createChatCompletionStream(
    params: ChatCompletionParamsStreaming,
  ): AsyncIterable<ChatCompletionChunk> {
    const stream = await this.client.chat.completions.create(params);
    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
