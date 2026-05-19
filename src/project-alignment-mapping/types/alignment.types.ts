/**
 * Shared types for the alignment resolver (BE-RESOLVER-01).
 *
 * These types are the READY-TO-RENDER projection used by PDF renderers
 * downstream. Master IDs are included for debugging/cross-referencing,
 * but `code` + `nameTh` are pre-flattened so the renderer needs no
 * further round-trip.
 *
 * §17.3 — alignment masters are config rows; no project FK; no
 * TrackingStatus interaction. This is a read-only projection.
 */

export interface AlignmentTriple {
  strategyId: string;
  tacticId: string;
  planId: string;
}

export interface AlignmentMasterRef {
  id: string;
  code: string | null;
  nameTh: string;
}

export interface AlignmentRow {
  nationalStrategy: AlignmentMasterRef;
  milestone: AlignmentMasterRef;
  sdg: AlignmentMasterRef;
  provinceStrategy: AlignmentMasterRef;
}

/**
 * Triple key format: `${strategyId}||${tacticId}||${planId}`.
 *
 * The `||` separator is chosen because strategy / tactic / plan ids in
 * this system are short numeric / alphanumeric tokens that never
 * contain that sequence. Use `buildTripleKey` rather than constructing
 * by hand so a future separator change ripples through one place.
 */
export type TripleKey = string;

export function buildTripleKey(triple: AlignmentTriple): TripleKey {
  return `${triple.strategyId}||${triple.tacticId}||${triple.planId}`;
}
