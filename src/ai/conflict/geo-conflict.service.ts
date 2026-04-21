/**
 * GeoConflictService — Wave 30 N1
 *
 * Deterministic, pure conflict assessment: given a resolved geo
 * feature (from Wave 29 `GeoFeatureLookupService`) and a project-type
 * proxy derived from the LAO ISSUE_BASED sub-type, return a structured
 * verdict `{ featureType, projectType, conflictLevel, reasons,
 * recommendations, rulesetVersion }`.
 *
 * Contract:
 *   - Pure: no I/O, no DB, no HTTP. First-match-wins lookup against
 *     `CONFLICT_MATRIX`.
 *   - Advisory only (§17.2). The `conflictLevel` output MUST NOT
 *     gate any workflow transition. N2's prompt will surface this
 *     verdict as a `[CONFLICT_ASSESSMENT]` block; the controller
 *     re-asserts the level from this service's output (not from
 *     LLM emission) per §17.9 prompt-injection defense.
 *   - No persistence, no TrackingStatus write, no FK into project
 *     tables (§17.3 audit separation).
 *   - No role exemption (§17.11).
 *
 * Defensive caps (per §17.9):
 *   - reasons[] and recommendations[] arrays are trimmed to 6 items
 *     each.
 *   - each string is trimmed to 240 characters.
 */
import { Injectable } from '@nestjs/common';
import {
  GEO_CONFLICT_RULESET_VERSION,
  SUBTYPE_TO_PROJECT_TYPE,
  resolveConflict,
} from './geo-conflict-rules';
import type {
  GeoAnalysisInput,
  GeoAnalysisResult,
  ProjectTypeCode,
} from './geo-conflict.types';

const MAX_LIST_ITEMS = 6;
const MAX_STRING_CHARS = 240;

@Injectable()
export class GeoConflictService {
  /**
   * Resolve the project-type code from a sub-type `code` taken from
   * the issue-rules registry. Unmapped / missing codes → `'unknown'`.
   */
  resolveProjectType(subTypeCode: string | null | undefined): ProjectTypeCode {
    if (!subTypeCode) return 'unknown';
    return SUBTYPE_TO_PROJECT_TYPE[subTypeCode] ?? 'unknown';
  }

  /**
   * Deterministic conflict verdict. Always returns a result (the
   * rules table contains a universal fallback — see
   * `CONFLICT_MATRIX`).
   */
  analyze(input: GeoAnalysisInput): GeoAnalysisResult {
    const raw = resolveConflict(input);
    return {
      featureType: raw.featureType,
      projectType: raw.projectType,
      conflictLevel: raw.conflictLevel,
      reasons: capList(raw.reasons),
      recommendations: capList(raw.recommendations),
      rulesetVersion: GEO_CONFLICT_RULESET_VERSION,
    };
  }
}

function capList(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed.slice(0, MAX_STRING_CHARS));
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}
