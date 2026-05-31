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
 *
 * --- Multi-value secondaries (Wave multi-national-strategy-per-alignment) ---
 *
 * Three dimensions (NationalStrategy, SDG, ProvinceStrategy) are now
 * multi-valued via sibling junction tables. The SOURCE-OF-TRUTH read
 * fields are the `*Strategies` / `sdgs` arrays. The scalar `*Strategy`
 * / `sdg` fields are retained for backward compatibility only and have
 * NO business meaning of "primary" / "ordering" / "priority" — see
 * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
 * §Scalar-FK Deprecation Contract.
 *
 * Milestone stays scalar — zero multi rows in the dataset; single by
 * domain. No junction.
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
  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   * Mirrors `nationalStrategies[0]` as a pure implementation artifact;
   * carries NO business meaning of "primary" / "ordering" / "priority".
   * New code MUST read `nationalStrategies[]` instead.
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  nationalStrategy: AlignmentMasterRef;

  /**
   * SOURCE OF TRUTH for ยุทธศาสตร์ชาติ on this alignment row.
   * ORDERED by `sort_order ASC, code ASC` from the junction. Length ≥ 1
   * (the back-compat scalar always occupies index 0).
   * Use this for ALL new read paths. The scalar `nationalStrategy`
   * field is @deprecated and retained only for backward compatibility
   * — see
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
   * §Scalar-FK Deprecation Contract.
   */
  nationalStrategies: AlignmentMasterRef[];

  /**
   * Milestone — stays scalar (no multi-value rows in current data;
   * single-valued by domain). No deprecation tag — this remains the
   * canonical read field.
   */
  milestone: AlignmentMasterRef;

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   * Mirrors `sdgs[0]` as a pure implementation artifact; carries NO
   * business meaning of "primary" / "ordering" / "priority".
   * New code MUST read `sdgs[]` instead.
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  sdg: AlignmentMasterRef;

  /**
   * SOURCE OF TRUTH for SDG on this alignment row.
   * ORDERED by `sort_order ASC, code ASC` from the junction. Length ≥ 1
   * (the back-compat scalar always occupies index 0).
   * Use this for ALL new read paths. The scalar `sdg` field is
   * @deprecated and retained only for backward compatibility — see
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
   * §Scalar-FK Deprecation Contract.
   */
  sdgs: AlignmentMasterRef[];

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   * Mirrors `provinceStrategies[0]` as a pure implementation artifact;
   * carries NO business meaning of "primary" / "ordering" / "priority".
   * New code MUST read `provinceStrategies[]` instead.
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  provinceStrategy: AlignmentMasterRef;

  /**
   * SOURCE OF TRUTH for ยุทธศาสตร์จังหวัด on this alignment row.
   * ORDERED by `sort_order ASC, code ASC` from the junction. Length ≥ 1
   * (the back-compat scalar always occupies index 0).
   * Use this for ALL new read paths. The scalar `provinceStrategy`
   * field is @deprecated and retained only for backward compatibility
   * — see
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
   * §Scalar-FK Deprecation Contract.
   */
  provinceStrategies: AlignmentMasterRef[];
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
