import type { OpenAI } from 'openai';

/**
 * PRIV-W44-01 — `LlmClient` abstraction (CLAUDE.md §17).
 *
 * Purpose:
 *   Central abstraction over LLM chat completion calls so every AI
 *   feature in the codebase goes through ONE chokepoint. The
 *   implementation may be swapped (OpenAI → Azure OpenAI, stub, etc.)
 *   by configuration only — business code never instantiates a
 *   provider SDK directly.
 *
 * §17.2 Advisory-only — this interface is pure compute. It MUST NOT
 * gate any workflow transition. Callers remain responsible for §17
 * staleness/audit discipline (§17.3 / §17.4) around each call.
 *
 * §17.3 Audit separation — this client NEVER writes to
 * `tracking_status` and has no knowledge of project/plan tables.
 *
 * §17.9 Prompt-injection defence — user-controlled text wrapping and
 * output schema validation are the caller's responsibility. This
 * client treats the `messages[]` array as an opaque pass-through.
 *
 * §17.11 No role exemption — there is no ambient "god mode" on this
 * client. Every call path still runs through the caller's own
 * permission, cooldown, and quota gates.
 */
export type ChatCompletionParamsNonStreaming =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

export type ChatCompletionParamsStreaming =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

export type ChatCompletionChunk =
  OpenAI.Chat.Completions.ChatCompletionChunk;

export interface LlmClient {
  /** Provider identity for audit / envelope provenance (§17.10). */
  readonly providerName: 'openai' | 'azure-openai' | 'stub';

  /** Non-streaming chat completion (the common case). */
  createChatCompletion(
    params: ChatCompletionParamsNonStreaming,
  ): Promise<ChatCompletion>;

  /** Streaming chat completion (executive chat, Wave 44). */
  createChatCompletionStream(
    params: ChatCompletionParamsStreaming,
  ): AsyncIterable<ChatCompletionChunk>;
}

/** DI token — consumers inject via `@Inject(LLM_CLIENT)`. */
export const LLM_CLIENT = Symbol('LLM_CLIENT');
