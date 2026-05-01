/**
 * line.module.ts — Wave 86 LINE chatbot integration.
 *
 * Wires the public webhook controller, signature guard, event router,
 * and (stubbed) AI bridge / messaging services. Phase 3 nodes
 * (W86-BE-LINE-AI-BRIDGE, W86-BE-LINE-MESSAGING) replace the stubs
 * in-place without changing the providers list shape.
 *
 * Imports `ThrottlerModule.forRoot` so the controller's `@Throttle`
 * decorator has an active tracker. The 100 req / 60s default applies
 * to the webhook endpoint only — module-scoped registration avoids
 * coupling LINE's rate-limit policy to global app-wide throttling.
 *
 * §17 alignment:
 *   - §17.2 advisory — entire module is conversational, never workflow.
 *   - §17.3 audit separation — no FK from `line_user_bindings` into
 *     project tables (already enforced at the entity layer).
 *   - §17.11 no role exemption — signature is the integrity boundary.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { LineUserBinding } from './entities/line-user-binding.entity';
import { LineWebhookController } from './line-webhook.controller';
import { LineSignatureGuard } from './line-signature.guard';
import { LineEventRouterService } from './line-event-router.service';
import { LineAiBridgeService } from './line-ai-bridge.service';
import { LineMessagingService } from './line-messaging.service';
// W86-BE-LINE-AI-BRIDGE Phase 3 — binding read/write helpers shared by
// the webhook router and AI bridge.
import { LineUserBindingService } from './line-user-binding.service';
// W86-BE-LINE-LOGIN-OAUTH — Login channel. Distinct from the Messaging
// channel above. Owns the `/initiate` + `/callback` OAuth/OIDC flow.
import { LineLoginController } from './line-login.controller';
import { LineLoginService } from './line-login.service';
import { LineJwksService } from './line-jwks.service';
// LineLoginService re-checks workStatus = approved at link-completion
// time per CLAUDE.md §1 + §2. WorkHistory repository is required for
// that check; registered via forFeature here.
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
// W86-BE-LINE-AI-BRIDGE Phase 3 — bridge LINE text-message events into
// the existing executive AI chat pipeline. Imported as a module so DI
// can resolve `AiExecutiveChatService` (exported from
// AiExecutiveChatModule per the Wave 86 cross-module wiring update).
// AiExecutiveConversation repo is also needed locally so the bridge
// can resolve / create the persistent LINE-channel conversation row.
import { AiExecutiveChatModule } from 'src/ai-executive-chat/ai-executive-chat.module';
import { AiExecutiveConversation } from 'src/ai-executive-chat/entities/ai-executive-conversation.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LineUserBinding,
      WorkHistory,
      // W86-BE-LINE-AI-BRIDGE Phase 3 — local repo registration so the
      // bridge can resolve / create the persistent LINE-channel
      // conversation row. AiExecutiveChatModule already registers this
      // entity for its own use; re-registering for injection is safe
      // and additive (NestJS dedupes the underlying repo provider).
      AiExecutiveConversation,
    ]),
    // Module-scoped throttler. The single entry uses NestJS's default
    // tracker name so `@Throttle({ default: ... })` on the controller
    // resolves correctly. If a global ThrottlerModule lands later via
    // AppModule, this scoped config still wins for line/* routes.
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    // W86-BE-LINE-AI-BRIDGE Phase 3 — depend on the AI module so its
    // exported `AiExecutiveChatService` is injectable here. The chat
    // service is consumed UNCHANGED via the SSE-drain shim inside
    // `LineAiBridgeService` (§17.2 advisory, §17.11 no role exemption).
    AiExecutiveChatModule,
  ],
  controllers: [LineWebhookController, LineLoginController],
  providers: [
    LineSignatureGuard,
    LineEventRouterService,
    LineAiBridgeService,
    LineMessagingService,
    // Phase 3 — shared binding read/write helpers.
    LineUserBindingService,
    LineLoginService,
    LineJwksService,
  ],
  exports: [
    // Phase 3 sibling nodes (LINE login, LINE messaging final impl)
    // may consume these services. Export for cross-module wiring.
    LineMessagingService,
    LineAiBridgeService,
    LineUserBindingService,
  ],
})
export class LineModule {}
