/**
 * OpenAI usage envelope.
 *
 * - `prompt_tokens` includes the FULL count of input tokens (cached +
 *   non-cached). OpenAI's Oct-2024 prompt-caching feature exposes the
 *   cached subset via `prompt_tokens_details.cached_tokens` — those
 *   tokens are billed at HALF the normal input rate (50% discount).
 *
 * Cost formula:
 *     non_cached_input = prompt_tokens - cached_tokens
 *     input_cost  = non_cached_input × input_price
 *                 + cached_tokens    × input_price × 0.5
 *     output_cost = completion_tokens × output_price
 *     total       = input_cost + output_cost
 *
 * If a response lacks `prompt_tokens_details` (legacy model / pre-cache
 * fallback), `cached_tokens` defaults to 0 → calculation matches the
 * pre-2024-10 behavior.
 */
export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
}

/**
 * Per-model OpenAI USD pricing per 1M tokens (input / output).
 *
 * IMPORTANT: This table is hand-maintained against
 * https://openai.com/api/pricing. OpenAI lowers prices periodically;
 * stale entries cause the platform to OVER-CHARGE the user vs. the
 * actual OpenAI invoice. P2 ships a verify script that diffs this
 * table against the live OpenAI pricing page.
 *
 * Last reviewed: 2026-05-17.
 */
export const PRICING = {
    // gpt-4o family (kept for backward compatibility — auto-title still
    // uses gpt-4o-mini per Wave 51 design; historical ai_usage_logs rows
    // still reference these model names; other AI services may still
    // route through gpt-4o for non-chat use cases).
    'gpt-4o': {
        input: 2.5, // $2.50 per 1M input tokens
        output: 10.0, // $10.00 per 1M output tokens
    },
    'gpt-4o-mini': {
        input: 0.15, // $0.15 per 1M input tokens
        output: 0.6, // $0.60 per 1M output tokens
    },
    // W68-FIX-08 (2026-04-28) — gpt-4.1 family added for executive-chat
    // migration. gpt-4.1-mini becomes the executive-chat default; nano
    // is the auto-downgrade target at ≥80% quota. gpt-4o hit the org's
    // 30k TPM ceiling at hop 2 of multi-tool loops; the 4.1 family has
    // 200k+ TPM, 1M context, and ~6× lower cost than gpt-4o while
    // matching its instruction-following quality.
    'gpt-4.1': {
        input: 2.0,  // $2.00 per 1M input tokens
        output: 8.0, // $8.00 per 1M output tokens
    },
    'gpt-4.1-mini': {
        input: 0.4,  // $0.40 per 1M input tokens
        output: 1.6, // $1.60 per 1M output tokens
    },
    'gpt-4.1-nano': {
        input: 0.1,  // $0.10 per 1M input tokens
        output: 0.4, // $0.40 per 1M output tokens
    },
};

/**
 * Cached-input discount factor (Oct 2024 prompt caching).
 * Cached input tokens are billed at 50% of the normal input rate.
 * Exposed as a constant so the P2 verify script can diff against
 * OpenAI's published discount factor.
 */
export const CACHED_INPUT_DISCOUNT = 0.5;

export function calculateAiCost(model: string, usage: TokenUsage): number {
    const modelPricing = PRICING[model as keyof typeof PRICING];
    if (!modelPricing) {
        console.warn(`Model ${model} pricing not found. Defaulting to 0.`);
        return 0;
    }

    const cachedTokens = Math.max(
        0,
        usage.prompt_tokens_details?.cached_tokens ?? 0,
    );
    // Defensive — OpenAI guarantees cached ≤ prompt, but clamp to be safe.
    const clampedCached = Math.min(cachedTokens, usage.prompt_tokens);
    const nonCachedInput = usage.prompt_tokens - clampedCached;

    const inputCost =
        (nonCachedInput / 1_000_000) * modelPricing.input +
        (clampedCached / 1_000_000) * modelPricing.input * CACHED_INPUT_DISCOUNT;
    const outputCost = (usage.completion_tokens / 1_000_000) * modelPricing.output;

    return inputCost + outputCost;
}
