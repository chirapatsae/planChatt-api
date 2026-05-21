import {
  IssueRuleEntry,
  ProvinceCode,
} from 'src/ai/criteria/issue-criteria.types';

/**
 * Strategy criteria response envelope — Wave LAO-ISSUE-STRATEGY-PARITY N1.
 *
 * Mirrors the existing `GET /v1/development-issue/:id/criteria` envelope,
 * with one LOAD-BEARING difference: this response carries an ARRAY of
 * registry entries (`entries[]`) rather than a single `entry`. A single
 * Strategy may resolve to multiple registry entries under the 1-to-many
 * umbrella model — e.g. STRAT003 maps to both `economic-3-1` and
 * `economic-3-2`; STRAT004 maps to both `urban-4-1to4` and `urban-4-5to6`.
 *
 * Engineers consuming both endpoints MUST NOT assume a shared response
 * type — see task BE-ENDPOINT §11 R2.
 *
 * Advisory-only per CLAUDE.md §17.2 — this response MUST NOT drive any
 * workflow transition.
 */
export class StrategyCriteriaResponseDto {
  strategyId: string;
  strategyName: string;
  rulesetVersion: string | null;
  /**
   * ARRAY (possibly empty). An empty array is a valid 200 response when
   * the Strategy exists but no registry entry matches its name — the FE
   * uses the empty array to decide "hide panel cleanly" (NOT an error).
   */
  entries: IssueRuleEntry[];
  provinceCode: ProvinceCode | null;
}
