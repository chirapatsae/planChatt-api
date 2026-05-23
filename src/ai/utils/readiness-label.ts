/**
 * Deterministic readinessLabel computation.
 *
 * Wave LAO-STRATEGY-AI-PARITY Followup G+R Coherence (2026-05-22).
 *
 * BACKGROUND
 * ----------
 * Before this module, both `AiService.generatePreSubmitReview` and
 * `StaffReviewPromptService.executeStaffReview` returned the LLM-supplied
 * `readinessLabel` verbatim alongside the (separately adjusted)
 * `overallScore`. The LLM was instructed to pick the label from the score
 * band, but in practice the two often disagreed — e.g. score=59 paired
 * with label="พร้อมส่ง" (a real production observation 2026-05-22, see
 * `docs/reports/`).
 *
 * That inconsistency confuses users and contradicts §17.10 five-element
 * display (score, band, staleness, timestamp, endpoint) which assumes the
 * band CHIP and the numeric SCORE are coherent.
 *
 * FIX
 * ---
 * Compute the label deterministically from the post-adjustment score on
 * the backend, AFTER `overallScoreAdjustment` (criticality-weighted
 * penalty) has been applied, and OVERRIDE whatever the LLM supplied.
 *
 * Bands (matching the existing reviewer prompt thresholds):
 *   - 85-100 → "พร้อมส่ง"
 *   - 60-84  → "ควรปรับปรุง"
 *   - 0-59   → "ต้องแก้ไขก่อนส่ง"
 *
 * CLAUDE.md compatibility
 * -----------------------
 * - §17.2 advisory-only: the label is still advisory, not a transition
 *   gate. We are NOT changing what the label DOES — only making it
 *   consistent with the numeric score it accompanies.
 * - §17.9 prompt-injection defense: the LLM can no longer influence the
 *   label via injection or hallucination. The label is purely a function
 *   of the deterministic post-adjustment score.
 * - §17.11 no role exemption: applies uniformly; no role override.
 */

export type ReadinessLabel = 'พร้อมส่ง' | 'ควรปรับปรุง' | 'ต้องแก้ไขก่อนส่ง';

export const READINESS_LABEL_BANDS = {
  READY: 'พร้อมส่ง',
  IMPROVE: 'ควรปรับปรุง',
  REWORK: 'ต้องแก้ไขก่อนส่ง',
} as const;

/**
 * Derive the readiness label deterministically from a 0-100 score.
 *
 * Clamps out-of-range inputs into the valid band domain so callers don't
 * have to pre-clamp. Non-finite / NaN inputs degrade to the most
 * conservative band ("ต้องแก้ไขก่อนส่ง") rather than throwing — this is
 * an observability path, not a workflow gate (§17.2).
 *
 * @param score - 0-100 numeric score (post-adjustment recommended)
 * @returns one of the three canonical Thai band labels
 */
export function deriveReadinessLabel(score: number): ReadinessLabel {
  if (!Number.isFinite(score)) return READINESS_LABEL_BANDS.REWORK;
  const clamped = Math.min(100, Math.max(0, score));
  if (clamped >= 85) return READINESS_LABEL_BANDS.READY;
  if (clamped >= 60) return READINESS_LABEL_BANDS.IMPROVE;
  return READINESS_LABEL_BANDS.REWORK;
}
