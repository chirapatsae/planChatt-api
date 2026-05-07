/**
 * Wave 58 W58-BE-AGG-01 — Canonical Thai display label for the
 * `DevelopmentPlan.reportFormat` enum (CLAUDE.md §16.9).
 *
 * Defect D1 (raw enum leak) root cause: tool envelopes shipped only the
 * machine enum (`STRATEGY_BASED` / `ISSUE_BASED`) without a paired Thai
 * display label, forcing the LLM to either translate the enum itself
 * (frequently leaking the literal English form) or omit the format from
 * its answer. The fix is structural: every plan-shaped envelope now
 * carries `reportFormatLabel` as a paired Thai string lookup so the LLM
 * never has to reason about the enum.
 *
 * §17.9 — static literal lookup, no user-controlled string flows
 * through. Unknown / unexpected enum values resolve to the empty string
 * (the LLM receives no Thai label and falls back to omitting the format,
 * which is preferable to echoing the unknown enum value).
 */

import { ReportFormat } from 'src/development-plan/types/report-format.enum';

export const REPORT_FORMAT_TH: Record<string, string> = {
  STRATEGY_BASED: 'แบบยุทธศาสตร์',
  ISSUE_BASED: 'แบบประเด็นการพัฒนา',
};

export function resolveReportFormatLabel(
  value: string | null | undefined,
): string {
  if (!value) return '';
  return REPORT_FORMAT_TH[value] ?? '';
}

/**
 * Convenience helper accepting either the enum scalar or a `null` /
 * `undefined`; defaults to STRATEGY_BASED when the column is missing
 * entirely, mirroring `listActivePlans.handler`'s existing fallback.
 */
export function resolveReportFormatLabelWithDefault(
  value: ReportFormat | string | null | undefined,
): string {
  const v = value ?? ReportFormat.STRATEGY_BASED;
  return resolveReportFormatLabel(String(v));
}
