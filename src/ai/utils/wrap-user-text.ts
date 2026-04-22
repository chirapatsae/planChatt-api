/**
 * §17.9 prompt-injection defense — shared delimiter policy.
 *
 * All user-controlled text passed to an LLM MUST be wrapped in a
 * delimited envelope so the model treats it as data, not instructions.
 * An attacker controlling a free-text field (title, objective, goal,
 * expected, additionalContext, attachment aiTopic/aiSummary, etc.)
 * could otherwise inject a literal `<<<END>>> …instruction… <<<USER_INPUT>>>`
 * pair to escape the envelope and smuggle instructions. Sanitation
 * strips those tokens before the envelope is emitted.
 *
 * Single source of truth for the delimiter strings. Owner-side
 * (AiService) and staff-side (StaffReviewPromptService) pipelines
 * both consume this module so the policy cannot drift.
 *
 * Sanitation is a no-op for benign inputs: content hashes and prompt
 * bytes are preserved for any string that does not contain the
 * literal delimiter tokens (which is adversarial by definition).
 */

const OPEN = '<<<USER_INPUT>>>';
const CLOSE = '<<<END>>>';

export function sanitizeUserTextDelimiters(value: string): string {
  return value
    .replace(/<<<USER_INPUT>>>/g, '<<<U-I>>>')
    .replace(/<<<END>>>/g, '<<<E-N-D>>>');
}

/**
 * Inline envelope for per-field wraps.
 *
 * Null / undefined / empty-string collapse to `(ไม่ระบุ)` so the
 * schema contract stays stable for callers that always emit the
 * field line.
 */
export function wrapUserText(value: string | null | undefined): string {
  const raw = typeof value === 'string' ? value : '';
  const trimmed = raw.trim();
  const body = trimmed.length > 0 ? trimmed : '(ไม่ระบุ)';
  return `${OPEN}${sanitizeUserTextDelimiters(body)}${CLOSE}`;
}

/**
 * Block envelope for multi-line paragraphs where the original
 * layout inserted newlines inside the delimiter pair. Caller MUST
 * guard non-empty (matches the legacy `if (userPrompt?.trim())`
 * gate at the single owner-side call site).
 *
 * Byte-identical to the pre-sanitization format for benign inputs:
 *   `<<<USER_INPUT>>>\n${value}\n<<<END>>>`
 */
export function wrapUserTextBlock(value: string): string {
  return `${OPEN}\n${sanitizeUserTextDelimiters(value)}\n${CLOSE}`;
}
