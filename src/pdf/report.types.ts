import type { TDocumentDefinitions } from 'pdfmake/interfaces';

export type YearKey = number;

export type PdfReportType =
  | 'default'
  | 'draft'
  | 'approved'
  | 'inAuthority'
  | 'outAuthority'
  | 'custom';

export interface PlanSummary {
  planName: string;
  perYearSum: Record<YearKey, number>;
  perYearCount: Record<YearKey, number>;
}

export interface StrategySummary {
  strategyName: string;
  plans: Map<string, PlanSummary>;
  perYearSum: Record<YearKey, number>;
  perYearCount: Record<YearKey, number>;
}

export interface ReportAggregations {
  strategies: Map<string, StrategySummary>;
  overallSum: Record<YearKey, number>;
  overallCount: Record<YearKey, number>;
  groupedProjects: Map<string, any[]>;
}

export interface CoverSummaryDocParams {
  developmentPlanName: string;
  years: number[];
  strategies: Map<string, StrategySummary>;
  overallSum: Record<YearKey, number>;
  overallCount: Record<YearKey, number>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
}

export interface ProjectDetailDocParams {
  developmentPlanName: string;
  years: number[];
  groupedProjects: Map<string, any[]>;
  availableColumns: string[];
  columnMap: Record<string, { text: string; key: string }>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
  reportType?: PdfReportType;
}

export type SummaryDocBuilder = (params: CoverSummaryDocParams) => TDocumentDefinitions;

export type ProjectDetailDocBuilder = (params: ProjectDetailDocParams) => TDocumentDefinitions | null;

// ---------------------------------------------------------------------------
// ISSUE_BASED interfaces (parallel to STRATEGY_BASED types above)
// ---------------------------------------------------------------------------

/**
 * Single-level summary for one DevelopmentIssue.
 * Parallel to StrategySummary but flat — no nested plan tree.
 */
export interface IssueSummary {
  issueName: string;
  sortOrder: number;
  perYearSum: Record<YearKey, number>;
  perYearCount: Record<YearKey, number>;
}

/**
 * Aggregated report data keyed by DevelopmentIssue.
 * Parallel to ReportAggregations.
 */
export interface IssueBasedReportAggregations {
  issues: Map<string, IssueSummary>;
  overallSum: Record<YearKey, number>;
  overallCount: Record<YearKey, number>;
  groupedProjects: Map<string, any[]>;
}

/**
 * Parameters for the cover/summary PDF page in ISSUE_BASED format.
 * Parallel to CoverSummaryDocParams.
 */
export interface IssueBasedCoverSummaryDocParams {
  developmentPlanName: string;
  years: number[];
  issues: Map<string, IssueSummary>;
  overallSum: Record<YearKey, number>;
  overallCount: Record<YearKey, number>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
}

/**
 * Parameters for the project detail PDF page in ISSUE_BASED format.
 * Parallel to ProjectDetailDocParams.
 * Replaces strategy/tactic/plan grouping with issue grouping.
 * KPI (indicator) column is not applicable for ISSUE_BASED.
 */
export interface IssueBasedProjectDetailDocParams {
  developmentPlanName: string;
  years: number[];
  groupedProjects: Map<string, any[]>;
  availableColumns: string[];
  columnMap: Record<string, { text: string; key: string }>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
  reportType?: PdfReportType;
}

/**
 * Parameters for the revision/edit summary PDF page in ISSUE_BASED format.
 * Parallel to RevisionEditSummaryDocParams (defined in
 * report-revision-edit-summary.part.ts).
 */
export interface IssueBasedRevisionEditSummaryDocParams {
  developmentPlanRevisionName: string;
  years: number[];
  issues: Map<string, IssueSummary>;
  overallSum: Record<YearKey, number>;
  overallCount: Record<YearKey, number>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
}

/**
 * Parameters for the revision/edit detail PDF page in ISSUE_BASED format.
 * Parallel to RevisionEditDetailDocParams (defined in
 * report-revision-edit-detail.part.ts).
 * KPI (indicator) column is not applicable for ISSUE_BASED.
 */
export interface IssueBasedRevisionEditDetailDocParams {
  developmentPlanRevisionName: string;
  years: number[];
  projects: Array<{
    current: any;
    previous: any;
    oldAdditionDetail?: string | null;
    additionalDetail?: string | null;
  }>;
  availableColumns: string[];
  columnMap: Record<string, { text: string; key: string }>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
  reportType?: string;
  pageOffset?: number;
}

export type IssueBasedSummaryDocBuilder = (
  params: IssueBasedCoverSummaryDocParams,
) => TDocumentDefinitions;

export type IssueBasedProjectDetailDocBuilder = (
  params: IssueBasedProjectDetailDocParams,
) => TDocumentDefinitions | null;

// ---------------------------------------------------------------------------
// SUPP_PRINT_BE_02 — Supplement PDF renderer parameter types.
//
// Supplements have NO previous-version comparison (unlike Revision/Edit).
// Each SPG renders as a single row inside its classification group, with an
// optional attachment-filename line beneath it (Q7=B). The cover page label
// is locked verbatim by Q3: "เล่มเพิ่มเติมรอบที่ {N} พ.ศ. {startBE}-{endBE}".
// ---------------------------------------------------------------------------

/**
 * Parameters for the STRATEGY_BASED supplement detail page renderer.
 * Parallel to RevisionEditDetailDocParams but flat (no previous-current pair).
 */
export interface SupplementDetailDocParams {
  developmentPlanSupplementName: string;
  years: number[];
  projects: any[]; // SupplementProjectGroup[] (loosely typed for renderer flexibility)
  availableColumns: string[];
  columnMap: Record<string, { text: string; key: string }>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
  reportType?: string;
  pageOffset?: number;
}

/**
 * Parameters for the ISSUE_BASED supplement detail page renderer.
 * Parallel to IssueBasedRevisionEditDetailDocParams but flat.
 * KPI (indicator) column is not applicable for ISSUE_BASED.
 */
export interface IssueBasedSupplementDetailDocParams {
  developmentPlanSupplementName: string;
  years: number[];
  projects: any[]; // SupplementProjectGroup[]
  availableColumns: string[];
  columnMap: Record<string, { text: string; key: string }>;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
  reportType?: string;
  pageOffset?: number;
}

/**
 * Parameters for the supplement cover page. Q3 LOCKED label:
 *   "เล่มเพิ่มเติมรอบที่ {supplementNumber} พ.ศ. {startYearBE}-{endYearBE}"
 *
 * Years are stored in the DB as Buddhist Era (e.g. 2566); no +543 conversion
 * happens in the renderer. The "ยุทธศาสตร์/ประเด็นการพัฒนา" badge is rendered
 * beneath the title to satisfy §16.9 admin-side format-badge requirement on
 * the cover page.
 */
export interface SupplementCoverDocParams {
  supplementNumber: number;
  startYearBE: number;
  endYearBE: number;
  parentPlanName: string;
  supplementDescription?: string | null;
  generatedAt: Date;
  generatedByName: string;
  reportFormat: 'STRATEGY_BASED' | 'ISSUE_BASED';
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
}

/**
 * Parameters for the supplement summary page. Format-aware: renders strategy
 * tree for STRATEGY_BASED, flat issue rows for ISSUE_BASED.
 *
 * One of `strategies` / `issues` MUST be provided based on `reportFormat`.
 */
export interface SupplementSummaryDocParams {
  developmentPlanSupplementName: string;
  years: number[];
  reportFormat: 'STRATEGY_BASED' | 'ISSUE_BASED';
  // STRATEGY_BASED inputs
  strategies?: Map<string, StrategySummary>;
  // ISSUE_BASED inputs
  issues?: Map<string, IssueSummary>;
  // Shared aggregations
  overallSum: Record<YearKey, number>;
  overallCount: Record<YearKey, number>;
  totalProjectCount: number;
  pageMargins: [number, number, number, number];
  pageOrientation: 'portrait' | 'landscape';
  newWord: (text: string) => any;
}

