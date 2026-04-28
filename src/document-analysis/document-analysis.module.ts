import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';
import { AiUsageLogsModule } from 'src/ai-usage-logs/ai-usage-logs.module';
import { AttachmentProjectGroup } from 'src/attachment-project-groups/entities/attachment-project-group.entity';
import { AttachmentRevisedProjectGroup } from 'src/attachment-revised-project-groups/entities/attachment-revised-project-group.entity';
import { DocumentAnalysisService } from './document-analysis.service';
// SEC-W44-02 — shared PII redactor.  The OCR → LLM path in
// `document-analysis.service.ts` is the PRIMARY PII-leak surface
// identified in the Wave 44 audit; the service injects
// PiiRedactorService and redacts before every LLM call.
import { PiiRedactorModule } from 'src/common/pii/pii-redactor.module';

/**
 * Known tesseract.js + leptonica native error signatures that can escape
 * the JS promise chain via `process.nextTick(() => { throw err })` on
 * unsupported input (PDF, corrupt image). These strings are string-matched
 * narrowly — we MUST NOT mask unrelated exceptions.
 *
 * P0 safety net — see FIX_OCR_PDF_CRASH_AND_RASTERIZATION.md §7.3.
 * The primary defence is the inline try/catch in `ocrBuffer` / `ocrFile`;
 * this listener exists purely as a belt-and-braces for error paths inside
 * tesseract's own worker that bypass the caller's try/catch.
 */
const KNOWN_OCR_ERROR_PATTERNS =
  /pixReadStream|attempting to read image|Pdf reading is not supported/i;

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttachmentProjectGroup,
      AttachmentRevisedProjectGroup,
    ]),
    AiUsageQuotasModule,
    // Wave 37 N2 — rich-detail log writes for DOCUMENT_SUMMARY. Direct
    // import is safe: `AiUsageLogsModule` is a leaf (no back-edge to
    // document-analysis), so no forwardRef is required.
    AiUsageLogsModule,
    PiiRedactorModule,
  ],
  providers: [DocumentAnalysisService],
  exports: [DocumentAnalysisService],
})
export class DocumentAnalysisModule implements OnModuleInit {
  private readonly logger = new Logger(DocumentAnalysisModule.name);

  onModuleInit(): void {
    const globalFlag = '__ocrSafetyNetInstalled';
    const g = global as unknown as Record<string, unknown>;
    if (g[globalFlag]) return;

    const matchOcr = (err: unknown): string | null => {
      const msg = err instanceof Error ? err.message : String(err);
      return KNOWN_OCR_ERROR_PATTERNS.test(msg) ? msg : null;
    };

    process.on('uncaughtException', (err) => {
      const msg = matchOcr(err);
      if (msg) {
        this.logger.error(
          `[DocumentAnalysis] Swallowed tesseract native uncaughtException: ${msg}`,
        );
        return;
      }
      // NOT ours — re-throw so Node's default handler (or a real
      // global error handler installed elsewhere) still sees it.
      throw err;
    });

    process.on('unhandledRejection', (reason) => {
      const msg = matchOcr(reason);
      if (msg) {
        this.logger.error(
          `[DocumentAnalysis] Swallowed tesseract native unhandledRejection: ${msg}`,
        );
        return;
      }
      // Not ours — do nothing here. A global rejection handler elsewhere
      // can still react; we do NOT re-throw because throwing inside an
      // unhandledRejection listener itself produces another uncaught error.
    });

    g[globalFlag] = true;
    this.logger.log(
      'OCR safety net installed (scoped to known tesseract/leptonica errors)',
    );
  }
}
