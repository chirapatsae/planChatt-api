/**
 * FeasibilityGateService — Wave 33.6 N1
 *
 * Deterministic, pure feasibility gate for the AI-generate pipeline.
 * Given a (geoFeature, projectType, conflictLevel) triple, returns a
 * structured verdict. When `severity === 'block'`, the call site (Wave
 * 33.6 N2 controller wiring + Wave 30 ai.service integration) MUST
 * short-circuit and skip the main `gpt-4o` call entirely — preventing
 * hallucinated copy for physically-impossible combos (e.g. a road in the
 * middle of a reservoir polygon).
 *
 * Compliance:
 *   - §17.2 — TOOL-BEHAVIOR gate. Decides whether AI emits copy on this
 *     one invocation; does NOT gate any workflow transition. Submit /
 *     approve / reject / pull-back / rollback paths are unaffected.
 *   - §17.3 — pure. No DB, no HTTP, no FK, no TrackingStatus write.
 *   - §17.5 — deterministic; no auto-recompute.
 *   - §17.9 — block path is fully deterministic (no LLM call). Reason +
 *     recommendations come from `feasibility-rules.ts` literals; defensive
 *     `sanitizeBriefingText` pass guards against future regressions where
 *     rule templates might blend LLM-authored strings.
 *   - §17.11 — no role exemption; every role gets the same verdict.
 *
 * Behavior:
 *   1. `geoFeature === null` → pass.
 *   2. `conflictLevel !== 'high'` → pass for none/low/unknown; warn for
 *      medium (Wave 30 [CONFLICT_ASSESSMENT] still surfaces the warning
 *      via prompt — this gate does NOT duplicate it).
 *   3. `conflictLevel === 'high'` AND water-body × land-construction
 *      AND an explicit rule exists in `FEASIBILITY_BLOCK_TABLE` → block
 *      with the rule's pre-authored Thai reason + recommendations.
 *   4. `conflictLevel === 'high'` AND water-body × land-construction
 *      AND NO explicit rule → pass (Wave 30 already surfaced; do NOT
 *      escalate without an explicit rule).
 *   5. Anything else → pass.
 *   6. Any unexpected throw → fail-open to pass (advisory per §17.2).
 */
import { Injectable, Logger } from '@nestjs/common';
import { sanitizeBriefingText } from '../briefing-sanitizer';
import {
  isWaterBodyVsLandConstruction,
  resolveBlockRule,
} from './feasibility-rules';
import type {
  FeasibilityInput,
  FeasibilitySeverity,
  FeasibilityVerdict,
} from './feasibility.types';

const MAX_REASON_CHARS = 240;
const MAX_RECOMMENDATIONS = 6;
const MAX_RECOMMENDATION_CHARS = 240;

@Injectable()
export class FeasibilityGateService {
  private readonly logger = new Logger(FeasibilityGateService.name);

  evaluate(input: FeasibilityInput): FeasibilityVerdict {
    try {
      // (1) No resolved feature → nothing to assess.
      if (!input || !input.geoFeature) {
        return { isFeasible: true, severity: 'pass' };
      }

      const level = input.conflictLevel;

      // (2) Below-high conflict → never escalate to block.
      //   - 'medium' surfaces as warn so the call site can record it; the
      //     Wave 30 [CONFLICT_ASSESSMENT] prompt block already informs
      //     the LLM, so no prompt change is needed at this severity.
      //   - 'low' / 'none' / 'unknown' → pass (conservative; Wave 30 is
      //     authoritative on the level).
      if (level !== 'high') {
        const severity: FeasibilitySeverity =
          level === 'medium' ? 'warn' : 'pass';
        return { isFeasible: true, severity };
      }

      // (3) High conflict gate — only water-body × land-construction
      // combos are eligible to block. Everything else passes (warn was
      // already emitted upstream when applicable).
      if (!isWaterBodyVsLandConstruction(input)) {
        return { isFeasible: true, severity: 'pass' };
      }

      // (3a) Look up explicit block rule. Absence → pass (do NOT escalate
      // without an explicit rule; §17.5 conservative).
      const rule = resolveBlockRule(
        input.geoFeature.featureType,
        input.projectType,
      );
      if (!rule) {
        return { isFeasible: true, severity: 'pass' };
      }

      // (3b) Compose verdict. Substitute `{nameTh}` placeholder. Sanitize
      // reason + each recommendation defensively (Wave 31 sanitizer is
      // idempotent on clean text). Cap lengths per §17.9.
      const nameTh = (input.geoFeature.nameTh ?? '').trim();
      const reasonRaw = rule.reason.replace('{nameTh}', nameTh);
      const reason = sanitizeBriefingText(reasonRaw)
        .trim()
        .slice(0, MAX_REASON_CHARS);

      const recommendations = rule.recommendations
        .slice(0, MAX_RECOMMENDATIONS)
        .map((r) =>
          sanitizeBriefingText(r).trim().slice(0, MAX_RECOMMENDATION_CHARS),
        )
        .filter((r) => r.length > 0);

      return {
        isFeasible: false,
        severity: 'block',
        reason,
        recommendations,
        triggeredRule: rule.id,
      };
    } catch (err) {
      // Fail-open per §17.2 — advisory only. Never let an evaluator bug
      // throttle the AI-generate pipeline.
      this.logger.warn(
        `[Feasibility] evaluator threw; defaulting to pass: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { isFeasible: true, severity: 'pass' };
    }
  }
}
