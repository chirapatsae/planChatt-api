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

