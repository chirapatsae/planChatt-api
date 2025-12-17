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

