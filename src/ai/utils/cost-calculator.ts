export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
}

export const PRICING = {
    'gpt-4o': {
        input: 2.5, // $2.50 per 1M input tokens
        output: 10.0, // $10.00 per 1M output tokens
    },
    'gpt-4o-mini': {
        input: 0.15, // $0.15 per 1M input tokens
        output: 0.6, // $0.60 per 1M output tokens
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
