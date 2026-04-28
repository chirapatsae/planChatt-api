import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `POST /v1/ai/executive-chat/messages` request body.
 *
 * CLAUDE.md references:
 *   - §17.9 — user-controlled text is length-capped server-side; the
 *     2000-char cap is belt-and-braces for prompt-injection defense.
 *   - §17.2 — this DTO carries only advisory signal; no workflow flag.
 *   - §17.4 — `conversationId` scopes the cooldown key; see
 *     `@AiCooldown('executive-chat', 6, 'body.conversationId')` on the
 *     controller.
 *
 * Sibling contracts:
 *   - BE-W44-02 consumes this DTO when wiring the SSE turn handler.
 *   - SEC-W44-02 redacts `message` via `PiiRedactorService` before it
 *     reaches the LLM; this DTO MUST NOT attempt redaction itself.
 *
 * Fields:
 *   - `conversationId` — optional uuid. Omit to start a new conversation.
 *   - `message`        — REQUIRED; 1..2000 chars after trim.
 *   - `modelHint`      — optional string advisory only (BE-W44-03's
 *                        80% auto-downgrade policy may override this
 *                        server-side).
 */
export class PostChatMessageDto {
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  modelHint?: string;
}
