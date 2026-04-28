/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `IAgencyEnrichment` annotates a `UnifiedProject[]` batch with the
 * Thai `GovernmentAgency.name` via LEFT JOIN.
 *
 * Contract rules (BE-W54-05 implementor):
 *   - READ-only.
 *   - NEVER projects the numeric agency id as a label — `agencyName`
 *     is the LLM-visible field, `agencyId` is carried for joins only.
 *   - Fallback label for unresolved FK: the static Thai string
 *     `'ไม่ระบุ'` (design §3.4).
 *   - Uses repository metadata resolution only (never raw SQL table
 *     literals).
 *
 * CLAUDE.md references:
 *   - §17.2 Advisory-only.
 *   - §17 PII discipline — GovernmentAgency is an organisation, not a
 *     person. `name` is safe to project.
 */
import type { MissingDimension, UnifiedProject } from '../types';

export interface AgencyLabel {
  /** Agency FK id (as stored on the row). Null when unset. */
  agencyId: number | null;
  /** Thai agency name. Fallback `'ไม่ระบุ'` when unresolved. */
  agencyName: string;
}

export interface AgencyEnrichmentResult {
  labels: Map<string, AgencyLabel>;
  missingDimensions: MissingDimension[];
  advisories: string[];
}

export interface IAgencyEnrichment {
  annotate(projects: UnifiedProject[]): Promise<AgencyEnrichmentResult>;
}
