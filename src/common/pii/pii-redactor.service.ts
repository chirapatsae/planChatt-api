/**
 * pii-redactor.service.ts (SEC-W44-02)
 *
 * Shared `@Injectable()` PII redactor for every AI prompt-build site.
 *
 * STRATEGY — redact INPUT, leave output alone.
 *   The LLM receives the masked `[ข้อมูลส่วนบุคคล]` token in place of
 *   detected PII.  The UI rehydrates from its own authoritative data;
 *   we never reverse-map placeholders on the response boundary.  This
 *   is strictly an OpenAI-egress defense (§17.9 complementary layer
 *   with the `<<<USER_INPUT>>>` delimiter envelope from
 *   `backend/src/ai/utils/wrap-user-text.ts`).
 *
 * Order of defense (caller responsibility):
 *     1. redactForPrompt(dto, policy, ctx)   ← this service
 *     2. wrapUserText(sanitized)             ← delimiter envelope
 *     3. openai.chat.completions.create()    ← LLM call
 *
 * The two defenses are orthogonal — delimiters prevent prompt
 * injection ("<<<END>>> ignore previous instructions"), redaction
 * prevents PII egress.  Neither substitutes for the other.
 *
 * CLAUDE.md references:
 *   §17.2  — advisory only; redaction never gates workflow.  If
 *            redaction throws, surface 400 PII_REDACTION_FAILED
 *            (caller responsibility); workflow actions (approve /
 *            submit / etc.) are unaffected.
 *   §17.3  — audit separation; telemetry stats may ride in the
 *            existing `ai_usage_logs.request_payload` jsonb; no new
 *            FK into project tables, no new storage table.
 *   §17.9  — complementary to delimiter wrap.  Order matters; this
 *            service runs FIRST.
 *   §17.11 — no role exemption.  Super-admin cannot bypass.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  addCounts,
  emptyCounts,
  PiiRedactionCounts,
  redactPiiWithCounts,
} from './pii-patterns';
import { PiiFieldAction, PiiFieldPolicy } from './field-policies';

const PLACEHOLDER_TOKEN = '[ข้อมูลส่วนบุคคล]';

export interface RedactContext {
  endpoint: string;
  fieldPath?: string;
}

export interface RedactTextResult {
  output: string;
  counts: PiiRedactionCounts;
}

export interface RedactStructuredResult<T> {
  output: T;
  counts: PiiRedactionCounts;
}

@Injectable()
export class PiiRedactorService {
  private readonly logger = new Logger(PiiRedactorService.name);

  /**
   * Regex-based redaction for free-text inputs.
   *
   * Emits a structured telemetry log line per call:
   *     `{event:'pii.redact', endpoint, fieldPath, counts:{...}}`
   * Ops can grep for `event=pii.redact` to observe residual PII rate
   * without seeing the actual redacted content (§17.3 — counts only,
   * never payload).
   */
  redactText(
    input: string | null | undefined,
    ctx: RedactContext,
  ): RedactTextResult {
    const { output, counts } = redactPiiWithCounts(input);
    this.emitTelemetry(ctx, counts);
    return { output, counts };
  }

  /**
   * Apply `PiiFieldPolicy` to every leaf of a structured DTO.
   *
   * - 'strip'       → field deleted from the output
   * - 'placeholder' → field replaced with PLACEHOLDER_TOKEN
   * - 'allow'       → string leaves run through regex redactText;
   *                   non-string leaves pass through unchanged
   *
   * Field paths support dot-notation and the `[]` wildcard for
   * arrays of objects (e.g. `attachments[].aiSummary`).  Unknown
   * keys default to `allow` so forgetting to catalog a field never
   * silently exposes raw PII.
   *
   * Pure — does NOT mutate the input payload (deep-cloned via
   * JSON round-trip, sufficient for AI-DTO shapes which are
   * structurally cloneable).
   */
  redactStructuredFields<T extends object>(
    payload: T,
    policy: PiiFieldPolicy,
    ctx: RedactContext = { endpoint: 'structured' },
  ): RedactStructuredResult<T> {
    if (payload === null || payload === undefined) {
      return { output: payload, counts: emptyCounts() };
    }
    let counts = emptyCounts();
    const cloned = this.safeClone(payload);
    this.walkAndRedact(cloned, '', policy, (leafCounts) => {
      counts = addCounts(counts, leafCounts);
    });
    this.emitTelemetry(ctx, counts);
    return { output: cloned as T, counts };
  }

  /**
   * Convenience combined-path used by prompt builders:
   *
   *     const {output, counts} =
   *       redactor.redactForPrompt(dto, POLICY, {endpoint:'...'});
   *
   * Equivalent to `redactStructuredFields` but emits the telemetry
   * event with `endpoint` in a single log line.  Kept as a distinct
   * method so call sites read clearly.
   */
  redactForPrompt<T extends object>(
    payload: T,
    policy: PiiFieldPolicy,
    ctx: RedactContext,
  ): RedactStructuredResult<T> {
    return this.redactStructuredFields(payload, policy, ctx);
  }

  // ─────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────

  private walkAndRedact(
    node: unknown,
    path: string,
    policy: PiiFieldPolicy,
    onCounts: (counts: PiiRedactionCounts) => void,
  ): void {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      const wildcardPath = path ? `${path}[]` : '[]';
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (typeof child === 'string') {
          const action = this.resolveAction(wildcardPath, policy);
          node[i] = this.applyLeafAction(child, action, onCounts);
        } else if (typeof child === 'object' && child !== null) {
          this.walkAndRedact(child, wildcardPath, policy, onCounts);
        }
      }
      return;
    }

    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    for (const key of Object.keys(obj)) {
      const childPath = path ? `${path}.${key}` : key;
      const child = obj[key];
      const action = this.resolveAction(childPath, policy, key);

      if (action === 'strip') {
        delete obj[key];
        continue;
      }
      if (action === 'placeholder') {
        obj[key] = PLACEHOLDER_TOKEN;
        continue;
      }
      // 'allow'
      if (typeof child === 'string') {
        obj[key] = this.applyLeafAction(child, 'allow', onCounts);
      } else if (Array.isArray(child)) {
        this.walkAndRedact(child, childPath, policy, onCounts);
      } else if (typeof child === 'object' && child !== null) {
        this.walkAndRedact(child, childPath, policy, onCounts);
      }
    }
  }

  private resolveAction(
    fullPath: string,
    policy: PiiFieldPolicy,
    bareKey?: string,
  ): PiiFieldAction {
    // Exact dotted-path hit
    if (fullPath in policy) return policy[fullPath];
    // Bare-key fallback so policies like `{citizenId: 'strip'}` work
    // regardless of nesting depth (e.g. `user.profile.citizenId`).
    if (bareKey && bareKey in policy) return policy[bareKey];
    // Default: allow + text-redact.  Failing open to `strip` here
    // would delete legitimate project fields (title, objective, …);
    // failing open to `allow` keeps the prompt functional and still
    // runs the regex pass on string leaves.
    return 'allow';
  }

  private applyLeafAction(
    value: string,
    action: PiiFieldAction,
    onCounts: (counts: PiiRedactionCounts) => void,
  ): string {
    if (action === 'strip') return '';
    if (action === 'placeholder') return PLACEHOLDER_TOKEN;
    // 'allow' → regex redact
    const { output, counts } = redactPiiWithCounts(value);
    onCounts(counts);
    return output;
  }

  private safeClone<T>(payload: T): T {
    // JSON round-trip is adequate for AI-DTO shapes (strings, numbers,
    // booleans, arrays, plain objects).  Dates / Buffers in an AI
    // prompt payload would be a bug — fail loud via the null->'' we
    // never do; the callers only pass plain DTO objects.
    return JSON.parse(JSON.stringify(payload)) as T;
  }

  private emitTelemetry(ctx: RedactContext, counts: PiiRedactionCounts): void {
    const total =
      counts.thaiId +
      counts.thaiPhone +
      counts.email +
      counts.longDigit +
      counts.address +
      counts.postal;
    if (total === 0) return;
    // Structured log — `event=pii.redact` is greppable by ops.  We
    // intentionally omit the payload and any redacted text; counts
    // only per §17.3.
    this.logger.log(
      `event=pii.redact endpoint=${ctx.endpoint}` +
        (ctx.fieldPath ? ` field=${ctx.fieldPath}` : '') +
        ` thaiId=${counts.thaiId} phone=${counts.thaiPhone}` +
        ` email=${counts.email} longDigit=${counts.longDigit}` +
        ` address=${counts.address} postal=${counts.postal}`,
    );
  }
}
