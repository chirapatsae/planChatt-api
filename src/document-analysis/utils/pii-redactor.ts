/**
 * pii-redactor.ts — legacy re-export shim (SEC-W44-02).
 *
 * The regex library moved to `src/common/pii/pii-patterns.ts` so the
 * shared `PiiRedactorService` (NestJS DI, telemetered) and any
 * response-side post-processing can share a single source of truth.
 * This file remains as a thin re-export to avoid breaking existing
 * `document-analysis.service.ts` call sites that redact AI OUTPUT
 * (topic / summary) for display.
 *
 * New callers — inject `PiiRedactorService` from
 * `src/common/pii/pii-redactor.module.ts` for telemetry-instrumented
 * redaction of INPUT payloads BEFORE the LLM call.
 */
export { redactPii, PII_MASK } from 'src/common/pii/pii-patterns';
