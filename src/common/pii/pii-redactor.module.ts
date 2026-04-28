/**
 * pii-redactor.module.ts (SEC-W44-02)
 *
 * NestJS module exporting `PiiRedactorService`.  Imported by every
 * module that owns a service which calls `openai.chat.completions.create`:
 *
 *   - `AiModule`
 *   - `DocumentAnalysisModule`
 *   - (Wave 44) `AiExecutiveChatModule` via BE-W44-02
 *
 * §17.11 — no role override; the service is a pure compute helper and
 * carries no authority hooks.
 */

import { Module } from '@nestjs/common';
import { PiiRedactorService } from './pii-redactor.service';

@Module({
  providers: [PiiRedactorService],
  exports: [PiiRedactorService],
})
export class PiiRedactorModule {}
