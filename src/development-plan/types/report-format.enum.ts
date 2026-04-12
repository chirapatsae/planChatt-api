/**
 * CLAUDE.md §16 Multi-Format Reporting — canonical format discriminator.
 *
 * This enum is owned by `DevelopmentPlan` and governs the classification
 * vocabulary used by every project under the plan (including revisions
 * and supplements via inheritance).
 *
 * Rules enforced elsewhere in the code base:
 *   - §16.3: format is declared ONLY on `DevelopmentPlan`; revisions and
 *     supplements inherit via JOIN.
 *   - §16.4: format is IMMUTABLE after `DevelopmentPlan` row insertion.
 *   - §16.5: classification shape invariant (STRATEGY_BASED xor ISSUE_BASED).
 *
 * IMPORTANT: this enum is DISTINCT from `PdfReportType` in
 * `src/pdf/report.types.ts` which is the orthogonal flavor discriminator
 * (`default | draft | approved | inAuthority | outAuthority | custom`).
 * Do not conflate the two.
 */
export enum ReportFormat {
  STRATEGY_BASED = 'STRATEGY_BASED',
  ISSUE_BASED = 'ISSUE_BASED',
}
