import { SetMetadata } from '@nestjs/common';

/**
 * AI Quota Weight decorator — per CLAUDE.md §17.8 (cooldown/quota are
 * COMPLEMENTARY) and §17.11 (no role exemption).
 *
 * STUB IMPLEMENTATION — BE-W44-01 scope.
 *
 * This decorator currently attaches metadata only. The paired
 * `AiQuotaGuard` + `QUOTA_WEIGHT_MAP` enforcement layer is owned by
 * BE-W44-03 and will consume the same metadata key once implemented.
 * No enforcement happens here; the presence of the decorator is a
 * forward-compatibility marker so BE-W44-01 controllers can declare
 * intent without depending on BE-W44-03 landing first.
 *
 * BE-W44-03 MUST:
 *   - keep this export path stable
 *   - keep the metadata key string stable
 *   - replace this file's implementation WITHOUT changing its public
 *     surface (decorator signature, metadata constant name)
 *
 * Example:
 *   @AiQuotaWeight('executive-chat')
 *   @Post('messages')
 *   sendMessage(...) { ... }
 */

export const AI_QUOTA_WEIGHT_METADATA = 'ai:quota-weight';

export function AiQuotaWeight(
  weightKey: string,
): MethodDecorator & ClassDecorator {
  return SetMetadata(AI_QUOTA_WEIGHT_METADATA, weightKey);
}
