/**
 * Project Dimension Helper — shared array-projection logic for the 3
 * multi-value alignment dimensions (NationalStrategy, SDG,
 * ProvinceStrategy).
 *
 * Consumed by:
 *  - `AlignmentResolverService.resolveMany`
 *    (PDF render path; MAIN / EDIT / CHANGE / SUPPLEMENT — §20 parity)
 *  - `ProjectAlignmentMappingService.lookup`
 *    (FE test-harness read path — `StrategicGraphTestAlignmentPage.tsx`)
 *
 * Both services need the same primary-first / sortOrder-ASC / dedup-by-id
 * projection. Centralising it here avoids drift between the two read
 * paths and matches the BE-01 task §7 sketch.
 *
 * §10 — scope binding is enforced upstream (the resolver is keyed by
 *       (strategy, tactic, plan) triples loaded from a project row);
 *       this helper is a pure projection over already-scoped rows.
 * §12 — config rows; NO TrackingStatus interaction.
 * §16.5 — alignment is STRATEGY_BASED only; ISSUE_BASED projects bypass
 *         the alignment resolver entirely.
 * §17.3 — alignment masters have no FK to project tables; pure read.
 *
 * Scalar-FK Deprecation Contract (README §Scalar-FK Deprecation
 * Contract): the scalar `primary` argument is the back-compat FK
 * value loaded from the alignment row. It carries NO business meaning
 * of "priority" / "order" / "primary" — it is treated mechanically as
 * the sort_order = 0 slot. NEW read paths MUST consume the returned
 * array, not the scalar field on the alignment row.
 */

export interface DimensionMasterRef {
  id: string;
  code: string | null;
  nameTh: string;
}

interface MasterLike {
  id: string;
  code?: string | null;
  nameTh: string;
}

/**
 * Build the ordered array for a single alignment dimension.
 *
 * Order contract (README §Scalar-FK Deprecation Contract §3):
 *  1. The scalar primary (the back-compat FK, treated as sort_order = 0).
 *  2. The junction entries sorted by `sortOrder ASC`, then `code ASC`
 *     as a deterministic tie-breaker so render order is stable across
 *     deploys.
 *  3. De-duplicated by `<ref>.id` so a row whose scalar id was also
 *     accidentally inserted into the junction does NOT double-render.
 *
 * @param primary    The scalar master ref already loaded from the
 *                   alignment row's @ManyToOne (back-compat slot).
 * @param junction   The list of junction rows loaded via @OneToMany.
 *                   May be `undefined` or `[]` for the 70+/75 rows that
 *                   have no secondaries — the helper handles both.
 * @param refKey     The property name on a junction row that holds
 *                   the nested master ref (e.g. 'nationalStrategy',
 *                   'sdg', 'provinceStrategy').
 * @param sortOrderKey Override only if a future junction uses a
 *                   different field name; defaults to 'sortOrder'.
 */
export function projectDimension<J, R extends MasterLike>(
  primary: R,
  junction: J[] | undefined,
  refKey: keyof J,
  sortOrderKey: keyof J = 'sortOrder' as keyof J,
): DimensionMasterRef[] {
  const primaryRef: DimensionMasterRef = {
    id: primary.id,
    code: primary.code ?? null,
    nameTh: primary.nameTh,
  };

  const seen = new Set<string>([primaryRef.id]);
  const list: DimensionMasterRef[] = [primaryRef];

  const sorted = (junction ?? [])
    .filter((j) => {
      const ref = j[refKey] as unknown as R | undefined;
      return !!ref && !seen.has(ref.id);
    })
    .sort((a, b) => {
      const ao = Number(a[sortOrderKey] ?? 0);
      const bo = Number(b[sortOrderKey] ?? 0);
      if (ao !== bo) return ao - bo;
      const ac = ((a[refKey] as unknown as R).code ?? '') as string;
      const bc = ((b[refKey] as unknown as R).code ?? '') as string;
      return ac.localeCompare(bc);
    });

  for (const j of sorted) {
    const ref = j[refKey] as unknown as R;
    seen.add(ref.id);
    list.push({
      id: ref.id,
      code: ref.code ?? null,
      nameTh: ref.nameTh,
    });
  }

  return list;
}
