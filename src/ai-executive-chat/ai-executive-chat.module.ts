import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiExecutiveConversation } from './entities/ai-executive-conversation.entity';
import { AiExecutiveMessage } from './entities/ai-executive-message.entity';
// Wave 44 BE-W44-01 — controller skeleton + executive-role guard.
import { AiExecutiveChatController } from './ai-executive-chat.controller';
import { ExecutiveRoleGuard } from './guards/executive-role.guard';
// Wave 44 BE-W44-01 — WorkHistory repository is required by the role
// guard. Registered here with `forFeature` so the guard can inject the
// repository without depending on any owning module's provider export.
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
// Wave 44 — quota guard lives in AiUsageQuotasModule. Importing the
// module gives us access to `AiQuotaGuard` via its `exports[]`.
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';
// AiCooldownGuard lives in `src/ai/guards/ai-cooldown.guard.ts`. It is
// NOT exported from AiModule, so we register it + its in-memory store
// locally here (mirroring the AiModule pattern). The store is
// per-module isolated, which matches the cooldown contract — each
// endpoint family owns its own cooldown namespace.
import { AiCooldownGuard } from 'src/ai/guards/ai-cooldown.guard';
import {
  AI_COOLDOWN_STORE,
  createAiCooldownStore,
} from 'src/ai/stores/ai-cooldown.store';
// PRIV-W44-01 — PDPA retention cron + right-to-access/erasure service.
// Both are registered locally; the retention cron piggybacks on the
// global `ScheduleModule.forRoot()` already wired in `app.module.ts`.
import { AiExecutiveChatRetentionCron } from './retention.cron';
import { AiExecutiveChatPdpaService } from './ai-executive-chat-pdpa.service';
// Admin-delete path writes an audit row; we need the `AiUsageLog`
// repository available to this module.
import { AiUsageLog } from 'src/ai-usage-logs/entities/ai-usage-log.entity';
// BE-W44-02 / SEC-W44-02 — PII redactor runs before every LLM egress
// (user text + tool-result projections), §17.9 complementary to the
// delimiter wrap performed inside `AiExecutiveChatService`.
import { PiiRedactorModule } from 'src/common/pii/pii-redactor.module';
// BE-W44-02 — SSE tool-call loop service.
import { AiExecutiveChatService } from './ai-executive-chat.service';
// Wave 54 BE-W54-01 — aggregation layer foundation. Scaffolds the
// Tier B composer surface (types, interfaces, module wiring); concrete
// providers land in BE-W54-02..05 and BE-W54-07. Dependency direction
// is one-way: this module imports AggregationModule; AggregationModule
// MUST NOT import AiExecutiveChatModule (circular-import mitigation per
// task §11.R1).
import { AggregationModule } from './aggregation/aggregation.module';
// `LlmClientModule` is registered `@Global()` — no explicit import
// required. The `LLM_CLIENT` token is resolved via DI from the root
// module's global registration in `app.module.ts`.

/**
 * AiExecutiveChatModule — Wave 44 Executive AI Chat feature module.
 *
 * BE-W44-01 extends DB-W44-01's entity-only skeleton with:
 *   - the controller skeleton (501 stubs where BE-W44-02 owns logic)
 *   - the `ExecutiveRoleGuard` admission check
 *   - imports for the quota + cooldown guards used by the guard chain
 *
 * BE-W44-02 will add:
 *   - `AiExecutiveChatService` with SSE streaming + tool-call loop
 *   - tool handler registration consuming the registry declared in
 *     `./tools/tool-registry.ts`
 *   - PII redactor + LLM client wiring
 *
 * Audit boundary (§17.3): the only FK leaving this module is the
 * intra-AI `AiExecutiveMessage.conversationId`. NO foreign key to
 * project / plan / tracking tables.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiExecutiveConversation,
      AiExecutiveMessage,
      // ExecutiveRoleGuard loads the caller's current WorkHistory. The
      // entity is also registered in the Work-History owning module;
      // re-registration for injection is safe and additive.
      WorkHistory,
      // PRIV-W44-01 — admin-delete audit row.
      AiUsageLog,
    ]),
    // BE-W44-03 owns the real `AiQuotaGuard`; importing its module here
    // ensures DI can resolve the guard when the controller references
    // it in `@UseGuards(AiQuotaGuard, AiCooldownGuard)`.
    AiUsageQuotasModule,
    // SEC-W44-02 — PII redaction for user text + tool results.
    PiiRedactorModule,
    // Wave 54 BE-W54-01 — Tier B aggregation layer (foundation only).
    AggregationModule,
  ],
  controllers: [AiExecutiveChatController],
  providers: [
    ExecutiveRoleGuard,
    // Local cooldown wiring — mirrors AiModule's factory-based store.
    {
      provide: AI_COOLDOWN_STORE,
      useFactory: () => createAiCooldownStore(),
    },
    AiCooldownGuard,
    // PRIV-W44-01 — PDPA surfaces.
    AiExecutiveChatPdpaService,
    AiExecutiveChatRetentionCron,
    // BE-W44-02 — SSE tool-call loop.
    AiExecutiveChatService,
  ],
  exports: [
    TypeOrmModule,
    // Wave 86 W86-BE-LINE-AI-BRIDGE — exported so LineModule can bridge
    // LINE webhook text-message events into the existing chat turn
    // pipeline. The export is read-only consumption: LINE consumes the
    // service via `sendMessage` and the SSE-drain shim
    // (`SseDrainResponse` in `line-ai-bridge.service.ts`); §17.2 / §17.11
    // — no method override, no role bypass, no workflow gate added.
    AiExecutiveChatService,
  ],
})
export class AiExecutiveChatModule {}
