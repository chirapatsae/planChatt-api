/**
 * Wave 58 W58-BE-AGG-02 — agency-label placeholder defense (Defect D6).
 *
 * Defect D6: chat answers rendered `responsibleAgency` as
 * `"หน่วยงานที่ <id>"` for every project. Backend grep returned ZERO
 * matches for the Thai literal `"หน่วยงานที่"` — the placeholder is LLM
 * synthesis from the bare numeric `responsibleAgencyId` field, NOT a
 * hardcoded literal anywhere in the BE. Fix is structural (provide
 * `responsibleAgencyName` from a DB JOIN) AND defensive — these regex
 * guards reject any envelope whose agency-string field accidentally
 * matches the smoking-gun pattern, so a future regression cannot
 * silently re-introduce the placeholder.
 *
 * The patterns are anchored (`^...$`) and the unicode-aware Thai literal
 * uses `\s*` rather than fixed-width whitespace so cosmetic variants
 * (`"หน่วยงานที่2"`, `"หน่วยงานที่ 2"`, `"หน่วยงานที่  2"`) are all caught.
 *
 * §17.9 — these regexes are static; they evaluate envelope payload
 * (server-authored), never user-controlled text routed through
 * `<<<USER_INPUT>>>` delimiters.
 */

export const FORBIDDEN_AGENCY_LABEL_PATTERNS: ReadonlyArray<RegExp> = [
  /^หน่วยงานที่\s*\d+$/,
  /^agency\s*#?\s*\d+$/i,
];

export interface AgencyLabelGuardOk {
  ok: true;
}

export interface AgencyLabelGuardFail {
  ok: false;
  field: 'responsibleAgencyName' | 'responsibleAgencyDisclosure';
  value: string;
  pattern: string;
}

export type AgencyLabelGuardResult = AgencyLabelGuardOk | AgencyLabelGuardFail;

/**
 * Validate a single project-row envelope against the placeholder
 * blacklist. Returns `{ok: true}` on pass, or a structured failure
 * record on the first match.
 *
 * Wave 58 contract:
 *   - `responsibleAgencyName` MUST NOT match a forbidden pattern.
 *   - `responsibleAgencyDisclosure` MUST NOT match a forbidden pattern.
 *   - null / undefined / empty values pass — only non-empty strings are
 *     scanned.
 */
export function checkAgencyLabelPlaceholder(row: {
  responsibleAgencyName?: string | null;
  responsibleAgencyDisclosure?: string | null;
}): AgencyLabelGuardResult {
  for (const field of [
    'responsibleAgencyName',
    'responsibleAgencyDisclosure',
  ] as const) {
    const v = row[field];
    if (typeof v !== 'string' || v.length === 0) continue;
    for (const rx of FORBIDDEN_AGENCY_LABEL_PATTERNS) {
      if (rx.test(v)) {
        return {
          ok: false,
          field,
          value: v,
          pattern: rx.source,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Throwing variant — used by handlers that want a hard server-side
 * defense before the envelope is sent to the LLM. The exception code is
 * stable for log filtering: `PROJECT_ENVELOPE_AGENCY_PLACEHOLDER`.
 */
export class AgencyLabelPlaceholderError extends Error {
  constructor(detail: AgencyLabelGuardFail) {
    super(
      `PROJECT_ENVELOPE_AGENCY_PLACEHOLDER: field=${detail.field} ` +
        `value=${JSON.stringify(detail.value)} pattern=${detail.pattern}`,
    );
    this.name = 'AgencyLabelPlaceholderError';
  }
}

export function assertAgencyLabelPlaceholderFree(row: {
  responsibleAgencyName?: string | null;
  responsibleAgencyDisclosure?: string | null;
}): void {
  const r = checkAgencyLabelPlaceholder(row);
  if (!r.ok) throw new AgencyLabelPlaceholderError(r);
}
