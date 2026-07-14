/**
 * SUPP-1 BE-04 — Canonical error codes for the Supplement owner-scope gate.
 *
 * These error codes are the SINGLE source of truth for:
 *   - the LAO-rejection gate on every owner-scoped SPG endpoint (Q2)
 *   - the agency-classification gate on every owner-scoped SPG endpoint (Q1)
 *
 * They are public-facing — frontend (Wave SUPP-2) handles them as HTTP 403
 * envelopes. Keep the string values stable; any rename is a contract break.
 *
 * See:
 *   - CLAUDE.md §1 (User Classification Rules)
 *   - CLAUDE.md §2 (Work Status Rule)
 *   - docs/workflow-add-project-supplement.md §4 (Q1 + Q2 Classification Gate)
 *   - docs/tasks/SUPP1_BE_04_SCOPE_MIDDLEWARE.md
 */

export const SUPPLEMENT_SCOPE_ERROR_CODES = {
  /**
   * Q2 — LAO-classified caller attempted an owner-scoped SPG action
   * (create / createDraft / updateDraft / publishDraft / pull_back).
   *
   * Returns HTTP 403. Frontend MUST hide the supplement entry points
   * for LAO users, but backend MUST NOT trust the UI hide.
   */
  LAO_NOT_ALLOWED_ON_SUPPLEMENT: 'LAO_NOT_ALLOWED_ON_SUPPLEMENT',

  /**
   * Q1 — caller is neither agency-classified (อบจ.นครราชสีมา) nor
   * LAO-classified. This is the edge-case bucket: missing amphoe,
   * missing localAdministrativeOrganization, or a workHistory that
   * does not match the §1 business rule on either side.
   *
   * Returns HTTP 403.
   */
  SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION:
    'SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION',
} as const;

export type SupplementScopeErrorCode =
  (typeof SUPPLEMENT_SCOPE_ERROR_CODES)[keyof typeof SUPPLEMENT_SCOPE_ERROR_CODES];

/**
 * User-facing Thai copy for the supplement-scope errors. Mirrors the
 * existing common/error-copy convention (e.g., `project-classification`
 * `ERROR_MESSAGES`). JSX / service code MUST import from this module
 * rather than hard-coding strings.
 */
export const SUPPLEMENT_SCOPE_ERROR_MESSAGES = {
  LAO_NOT_ALLOWED_ON_SUPPLEMENT:
    'ผู้ใช้งานในกลุ่ม อปท. ไม่สามารถดำเนินการกับโครงการในรอบเพิ่มเติมได้',
  SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION:
    'การดำเนินการกับโครงการในรอบเพิ่มเติมต้องอยู่ในสังกัดเทศบาลตำบลหนองกระทุ่มเท่านั้น',
} as const;
