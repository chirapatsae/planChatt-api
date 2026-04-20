import { Injectable, Logger } from '@nestjs/common';
import { GeoBoundaryService } from '../geo-boundary.service';
import {
  CriterionHint,
  IssueRuleEntry,
} from './issue-criteria.types';

/**
 * Wave 24 N4 — deterministic geospatial pre-check.
 *
 * Source of truth: `docs/architecture/ISSUE_BASED_CRITERIA.md` §7.
 *
 * Scope (Wave 24):
 *   - `cross-amphoe` — for criteria flagged `geoAutoCheck:'cross-amphoe'`
 *     (currently `C3_2.a` and `C4_1to4.a`), compare the amphoe
 *     containing `startLat/Lng` vs the amphoe containing `endLat/Lng`.
 *     Different amphoes => `pass`; same amphoe => `needs-evidence`;
 *     missing coords / unresolved polygons => no hint (LLM decides).
 *
 * NOT in scope (Wave 24B):
 *   - `in-protected-zone` for `C3_2.c` — forest / watershed overlays
 *     are not in this repo. Criteria stay `source:'llm'` until then.
 *
 * Invariants:
 *   - Reuses `GeoBoundaryService`'s pre-loaded polygon index; we do
 *     NOT open `geojson/nakhon-ratchasima-districts.json` a second time
 *     (architecture §7 / §10 Wave 20 asset reuse).
 *   - Hints are advisory per §17.2 — they NEVER gate submission.
 *   - Hints are SYSTEM-generated content; they go into the prompt
 *     UNDELIMITED as trusted context while user-supplied text remains
 *     inside `<<<USER_INPUT>>>…<<<END>>>` (§17.9).
 */
@Injectable()
export class IssueCriteriaGeoCheckService {
  private readonly logger = new Logger(IssueCriteriaGeoCheckService.name);

  constructor(private readonly geoBoundary: GeoBoundaryService) {}

  /**
   * Evaluate every `cross-amphoe` criterion declared by the entry.
   *
   * @returns Array of deterministic hints. Empty array when no criterion
   *          in the entry supports geo auto-check or when coordinates
   *          are missing / unresolved.
   */
  evaluate(
    entry: IssueRuleEntry,
    coords: {
      startLat?: number | null;
      startLng?: number | null;
      endLat?: number | null;
      endLng?: number | null;
    },
  ): CriterionHint[] {
    const hints: CriterionHint[] = [];

    // Only criteria actually flagged `cross-amphoe` are evaluated here.
    // The list is tiny (2 criteria in Wave 24) so the linear scan is
    // cheaper than building an index.
    const crossAmphoeCriteria = entry.criteria.filter(
      (c) => c.geoAutoCheck === 'cross-amphoe',
    );
    if (crossAmphoeCriteria.length === 0) return hints;

    const { startLat, startLng, endLat, endLng } = coords;
    const hasStart =
      typeof startLat === 'number' &&
      Number.isFinite(startLat) &&
      typeof startLng === 'number' &&
      Number.isFinite(startLng);
    const hasEnd =
      typeof endLat === 'number' &&
      Number.isFinite(endLat) &&
      typeof endLng === 'number' &&
      Number.isFinite(endLng);

    // Missing either endpoint => we cannot make a deterministic call.
    // Emit no hint; the LLM will handle the row as `source:'llm'`.
    if (!hasStart || !hasEnd) {
      this.logger.debug(
        `[GeoCheck] skipped: coords incomplete hasStart=${hasStart} hasEnd=${hasEnd}`,
      );
      return hints;
    }

    const startResolved = this.geoBoundary.resolveAmphoeForPoint(
      startLat as number,
      startLng as number,
    );
    const endResolved = this.geoBoundary.resolveAmphoeForPoint(
      endLat as number,
      endLng as number,
    );

    // If either endpoint falls outside every indexed polygon, we
    // cannot confirm cross-amphoe status — leave the row for the LLM.
    if (!startResolved || !endResolved) {
      this.logger.debug(
        `[GeoCheck] skipped: unresolved start=${startResolved?.amphoeCode ?? 'null'} end=${endResolved?.amphoeCode ?? 'null'}`,
      );
      return hints;
    }

    const crossAmphoe = startResolved.amphoeCode !== endResolved.amphoeCode;

    for (const criterion of crossAmphoeCriteria) {
      hints.push({
        criterionId: criterion.id,
        suggestedVerdict: crossAmphoe ? 'pass' : 'needs-evidence',
        reason: crossAmphoe
          ? `จุดเริ่มอยู่ในอำเภอรหัส ${startResolved.amphoeCode} และจุดปลายอยู่ในอำเภอรหัส ${endResolved.amphoeCode} — คาบเกี่ยวระหว่าง อปท.`
          : `จุดเริ่มและจุดปลายอยู่ในอำเภอเดียวกัน (รหัส ${startResolved.amphoeCode}) — ไม่พบหลักฐานคาบเกี่ยวโดยอัตโนมัติ`,
        kind: 'geo-auto',
        // Geo auto-check is authoritative — the polygon answer is a
        // fact, not an opinion (architecture §7).
        hardOverride: true,
      });
    }

    this.logger.debug(
      `[GeoCheck] issueKey=${entry.issueKey} hints=${hints.length} crossAmphoe=${crossAmphoe}`,
    );
    return hints;
  }
}
