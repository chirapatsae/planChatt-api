/**
 * Wave 36 N2 — §17.9 compliance. Strips raw user-authored prose from
 * request payloads before they're persisted to `ai_usage_logs`.
 *
 * Deny-list approach: known user-prose field names (`userPrompt`,
 * `additionalContext`, `justification`, `description`, `objective`,
 * `rawText`, `ocrText`) are dropped entirely. A length-only substitute
 * (`${key}Length`) is emitted for observability without retaining the
 * original content.
 *
 * Recursion: descends into nested objects and arrays so a deny-listed
 * key buried at any depth is still stripped. Non-object / primitive
 * inputs pass through unchanged.
 *
 * This sanitizer MUST be invoked on every `requestPayload` handed to
 * `AiUsageLogsService.create()` — the absence of a persistence-layer
 * CHECK means this function is the single enforcement point.
 */

const USER_PROSE_FIELDS = new Set([
  'userPrompt',
  'additionalContext',
  'justification',
  'description',
  'objective',
  'rawText',
  'ocrText',
]);

export function sanitizeRequestPayload(input: unknown): any {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => sanitizeRequestPayload(v));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (USER_PROSE_FIELDS.has(key)) {
      // Replace with length metric only — never persist the raw text.
      if (typeof value === 'string') {
        out[`${key}Length`] = value.length;
      } else if (value === null || value === undefined) {
        out[`${key}Length`] = 0;
      }
      continue;
    }
    if (value !== null && typeof value === 'object') {
      out[key] = sanitizeRequestPayload(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
