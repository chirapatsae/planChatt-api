import { Global, Module } from '@nestjs/common';
import { LLM_CLIENT } from './llm-client.interface';
import { OpenAILlmClient } from './openai-llm-client.service';

/**
 * PRIV-W44-01 — global DI module for the `LlmClient` abstraction.
 *
 * Registered as `@Global()` so every AI-consuming module (ai,
 * document-analysis, ai-executive-chat, …) can inject
 * `@Inject(LLM_CLIENT)` without re-importing this module.
 *
 * Future provider swap (Option B — Azure OpenAI Southeast Asia) will
 * be a ONE-LINE change in this module: replace `OpenAILlmClient` with
 * the Azure adapter and the rest of the codebase is untouched. See
 * `docs/ops/openai-dpa.md` §5 for the migration decision matrix.
 */
@Global()
@Module({
  providers: [
    OpenAILlmClient,
    {
      provide: LLM_CLIENT,
      useExisting: OpenAILlmClient,
    },
  ],
  exports: [LLM_CLIENT, OpenAILlmClient],
})
export class LlmClientModule {}
