export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
}

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

export function calculateAiCost(model: string, usage: TokenUsage): number {
    const modelPricing = PRICING[model as keyof typeof PRICING];
    if (!modelPricing) {
        console.warn(`Model ${model} pricing not found. Defaulting to 0.`);
        return 0;
    }

    const inputCost = (usage.prompt_tokens / 1_000_000) * modelPricing.input;
    const outputCost = (usage.completion_tokens / 1_000_000) * modelPricing.output;

    return inputCost + outputCost;
}
