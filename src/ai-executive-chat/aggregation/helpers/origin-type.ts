/**
 * Wave 57 W57-BE-AGG-02 — Single source of truth for the §1 + §5
 * origin-type classifier.
 *
 * CLAUDE.md references:
 *   - §1 User Classification — agency iff WH.amphoe.id === '3001' AND
 *     WH.LAO.id === '3001027'; lao otherwise.
 *   - §5 Project Type & Agency Assignment Rules — `originType` is
 *     derived from the CREATOR's WorkHistory at row insertion time and
 *     is immutable. MUST NOT be inferred from `responsibleAgency` or
 *     `originAgencyId`.
 *
 * `PAO_AMPHOE_ID` and `PAO_LAO_ID` correspond to อบจ. (PAO) — Provincial
 * Administrative Organization — the only "agency" classification at
 * Nakhon Ratchasima per §1.
 *
 * `classifyOriginFromWorkHistory` is the canonical helper. Inline magic-
 * number comparisons are forbidden after this task; new sites MUST
 * import the helper.
 *
 * §17.11 no role exemption — origin classification is data-driven, not
 * permission-driven; no role can override.
 */

/** Sentinel WorkHistory.amphoe.id for อบจ. (Nakhon Ratchasima PAO). */
export const PAO_AMPHOE_ID = '3001' as const;

/** Sentinel WorkHistory.localAdministrativeOrganization.id for อบจ. */
export const PAO_LAO_ID = '3001027' as const;

/**
 * Discriminated origin type (matches `UnifiedProject.originType`).
 *
 *   - `'agency-normal'`   → creator WH classified as agency.
 *   - `'lao-coordinated'` → all other creator classifications.
 */
export type OriginType = 'agency-normal' | 'lao-coordinated';

/** Minimal WH-shaped input — only the two ID scalars are needed. */
export interface OriginWorkHistoryShape {
  amphoe?: { id?: string | number | null } | null;
  localAdministrativeOrganization?: { id?: string | number | null } | null;
}

/**
 * Canonical classifier. Accepts a WH row (or null) and returns the
 * derived `OriginType`. Null / missing relations resolve to
 * `'lao-coordinated'` (the safe non-agency default per §1).
 *
 * IMPLEMENTATION NOTE: per §5 immutability, callers MUST pass the WH
 * that was attached to the project at creation time (via
 * `project.createdBy`), NOT the caller's current WH.
 */
export function classifyOriginFromWorkHistory(
  wh: OriginWorkHistoryShape | null | undefined,
): OriginType {
  if (!wh) return 'lao-coordinated';
  const amphoeId = wh.amphoe?.id == null ? '' : String(wh.amphoe.id);
  const laoId =
    wh.localAdministrativeOrganization?.id == null
      ? ''
      : String(wh.localAdministrativeOrganization.id);
  return amphoeId === PAO_AMPHOE_ID && laoId === PAO_LAO_ID
    ? 'agency-normal'
    : 'lao-coordinated';
}

/**
 * ID-scalar variant — used by the SQL-projection layer where only the
 * `wh_amp.id` and `wh_lao.id` raw values are available. Mirrors the
 * private helper in `UnifiedProjectAggregator.toOriginType` but lives
 * here so every site shares the same constants.
 */
export function classifyOriginFromIdScalars(
  creatorAmphoeId: string | number | null | undefined,
  creatorLaoId: string | number | null | undefined,
): OriginType {
  const a = creatorAmphoeId == null ? '' : String(creatorAmphoeId);
  const l = creatorLaoId == null ? '' : String(creatorLaoId);
  return a === PAO_AMPHOE_ID && l === PAO_LAO_ID
    ? 'agency-normal'
    : 'lao-coordinated';
}
