/**
 * field-policies.ts (SEC-W44-02)
 *
 * Per-endpoint catalog of DTO-field redaction policies.
 *
 * Three policy kinds:
 *   - 'strip'       : the field is deleted from the outgoing prompt payload
 *   - 'placeholder' : the field is replaced with a constant token
 *   - 'allow'       : the field passes through, but string leaves are run
 *                     through `redactText` (regex pass) before prompt build
 *
 * Field paths use dot-notation and support the wildcard `[]` for arrays
 * of objects (e.g. `attachments[].aiSummary`).  Unknown keys default to
 * `allow` — i.e. text-only regex pass — so forgetting to catalog a field
 * never silently exposes raw PII.
 *
 * CLAUDE.md references:
 *   §17.9 — redaction is COMPLEMENTARY to delimiter wrap; both layers
 *           run BEFORE the LLM call.
 *   §17.11 — no role override; policies apply to all callers uniformly.
 */

export type PiiFieldAction = 'strip' | 'placeholder' | 'allow';

export type PiiFieldPolicy = Record<string, PiiFieldAction>;

/**
 * Generic per-user PII keys that MUST never be leaked to an LLM.
 * Used as the default baseline for every policy.
 */
const BASE_PERSONAL_KEYS: PiiFieldPolicy = {
  firstName: 'strip',
  lastName: 'strip',
  fullName: 'strip',
  citizenId: 'strip',
  nationalId: 'strip',
  phone: 'strip',
  phoneNumber: 'strip',
  email: 'strip',
  address: 'strip',
  homeAddress: 'strip',
  personalAddress: 'strip',
};

/**
 * `generate-project-detail` — main project-generation endpoint.
 * User seed text (`userPrompt`, `additionalContext`) is free-form
 * user prose → allow + text-redact.
 */
export const PROJECT_PROMPT_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
  userPrompt: 'allow',
  additionalContext: 'allow',
  // Project content — safe
  title: 'allow',
  objective: 'allow',
  goal: 'allow',
  expected: 'allow',
  indicator: 'allow',
  strategyName: 'allow',
  tacticName: 'allow',
  planName: 'allow',
  developmentIssueName: 'allow',
  organizationName: 'allow',
  amphoeName: 'allow',
};

/**
 * `regenerate-one-field` — single-field regeneration.
 */
export const REGEN_PROMPT_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
  existingContent: 'allow',
  instruction: 'allow',
  modificationPrompt: 'allow',
  targetFieldName: 'allow',
};

/**
 * `pre-submit-review` / `staff-review-analyze` — reviewer prompts.
 * Attachment OCR summaries may have leaked PII upstream; text-redact.
 */
export const REVIEW_PROMPT_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
  'project.title': 'allow',
  'project.objective': 'allow',
  'project.goal': 'allow',
  'project.expected': 'allow',
  'project.indicator': 'allow',
  additionalContext: 'allow',
  'attachments[].aiSummary': 'allow',
  'attachments[].aiTopic': 'allow',
};

/**
 * `document-summary` — OCR result → LLM.  PRIMARY PII-leak path.
 * Whole blob is free text → text-redact.
 */
export const OCR_PROMPT_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
  ocrText: 'allow',
  text: 'allow',
};

/**
 * `executive-chat` — user message + tool-result leaves.
 * Consumed by BE-W44-02 executive-chat service.
 */
export const EXECUTIVE_CHAT_PROMPT_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
  message: 'allow',
};

export const EXECUTIVE_CHAT_TOOL_RESULT_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
  // Tool results are projections chosen by the tool adapter; every
  // string leaf gets redactText to catch residual PII from OCR or
  // free-text fields not removed by the projection.
};

/**
 * `prompt-suggestions` — 5-line Thai prompt ideation.  Contextual
 * metadata only; no user prose today, but apply baseline for safety.
 */
export const PROMPT_SUGGESTIONS_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
  strategyName: 'allow',
  tacticName: 'allow',
  planName: 'allow',
  developmentIssueName: 'allow',
  amphoeName: 'allow',
  organizationName: 'allow',
};

/**
 * `land-use-classify` — deterministic tambon/amphoe structured input.
 * No user prose by design, but the uniform baseline keeps future
 * additions safe.
 */
export const LAND_USE_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
};

/**
 * `smart-approve` — structured DTO + user-seeded `additionalContext`.
 */
export const SMART_APPROVE_POLICY: PiiFieldPolicy = {
  ...BASE_PERSONAL_KEYS,
  'project.title': 'allow',
  'project.objective': 'allow',
  'project.goal': 'allow',
  'project.expected': 'allow',
  'project.indicator': 'allow',
  additionalContext: 'allow',
};
