import { SetMetadata } from '@nestjs/common';

/**
 * AI Cooldown decorator — per CLAUDE.md §17.8 (AI-Assist Rule cooldown canon).
 *
 * Attach to any AI endpoint that should be rate-limited per
 * `(actor × target × endpointKey)`. Works together with AiCooldownGuard.
 *
 * Example:
 *   @AiCooldown('smart-approve', 10)
 *   @Post('smart-approve/analyze')
 *   async analyze(...)
 *
 * Params:
 *   endpointKey: Stable logical name for the endpoint (used in the cooldown
 *                key and in observability). Keep it short and stable.
 *   ttlSeconds:  Cooldown window length. Also returned as `Retry-After` and
 *                `remainingSeconds` when a 429 fires.
 *   keyFrom:     Where to pull the target identifier from on the incoming
 *                request. Supports a handful of conventional body paths.
 *                Defaults to 'body.projectId' (most common for smart-approve).
 */

export type AiCooldownKeyFrom =
  | 'body.targetId'
  | 'body.revisedProjectGroupId'
  | 'body.projectId'
  | 'body.supplementProjectGroupId'
  // Wave 44 — executive-chat cooldown key. Conversations without an id
  // collapse to `__no_target__` in the guard so users cannot evade the
  // window by omitting the field.
  | 'body.conversationId';

export interface AiCooldownMetadata {
  endpointKey: string;
  ttlSeconds: number;
  keyFrom: AiCooldownKeyFrom;
}

export const AI_COOLDOWN_METADATA = 'ai-cooldown:metadata';

export function AiCooldown(
  endpointKey: string,
  ttlSeconds: number,
  keyFrom: AiCooldownKeyFrom = 'body.projectId',
): MethodDecorator & ClassDecorator {
  const metadata: AiCooldownMetadata = { endpointKey, ttlSeconds, keyFrom };
  return SetMetadata(AI_COOLDOWN_METADATA, metadata);
}
