/**
 * Wave 58 W58-BE-AGG-03 — Plan activity-status static label tables.
 *
 * Defect D2 (Q-USER-VOCAB Option B "two-badge layout") root cause: every
 * plan envelope shipped only `isLatest` / `isBooked` booleans, forcing
 * the LLM to invent a Thai phrase such as "เล่มล่าสุด" or "เปิดส่งโครงการ"
 * from those scalars. The fix is structural: the plan envelope now
 * carries TWO orthogonal signals as pre-translated Thai strings,
 *
 *   1. `freshness`  — `'latest' | 'historical'` (paired Thai label).
 *   2. `activities` — open-state stack across PlanPhase, DPR (edit),
 *                     DPR (change), DPS. `'none'` is a mutually-exclusive
 *                     sentinel emitted only when ALL four signals are
 *                     closed.
 *
 * §17.9 — static literal lookups, no user-controlled string flows
 * through. The keys are the canonical machine enums; the values are the
 * exact Thai strings the LLM will copy verbatim. Unknown keys resolve to
 * an empty string (the LLM falls back to omitting the badge — preferable
 * to leaking a machine identifier).
 */

export type PlanFreshnessKey = 'latest' | 'historical';

export type PlanActivityKey =
  | 'submit-open'
  | 'edit-open'
  | 'change-open'
  | 'supplement-open'
  | 'none';

export const FRESHNESS_LABEL_TH: Record<PlanFreshnessKey, string> = {
  latest: 'เล่มล่าสุด',
  historical: 'เล่มเก่า',
};

export const ACTIVITY_LABEL_TH: Record<PlanActivityKey, string> = {
  'submit-open': 'เปิดส่งโครงการ',
  'edit-open': 'เปิดรอบแก้ไข',
  'change-open': 'เปิดรอบเปลี่ยนแปลง',
  'supplement-open': 'เปิดเล่มเพิ่มเติม',
  none: 'ไม่มีกิจกรรมเปิด',
};

export function resolveFreshnessLabel(key: PlanFreshnessKey): string {
  return FRESHNESS_LABEL_TH[key] ?? '';
}

export function resolveActivityLabel(key: PlanActivityKey): string {
  return ACTIVITY_LABEL_TH[key] ?? '';
}

/**
 * Sort order applied to the `activities[]` array. Per task §10
 * acceptance criteria: alphabetical ascending by `key`. The four
 * open-* keys MUST never appear together with `'none'` (mutual
 * exclusion enforced by the producer in `executive-tool-handlers.ts`).
 */
export const PLAN_ACTIVITY_KEYS_OPEN: ReadonlyArray<PlanActivityKey> = [
  'change-open',
  'edit-open',
  'submit-open',
  'supplement-open',
];

export interface PlanActivityStatus {
  freshness: PlanFreshnessKey;
  freshnessLabel: string;
  activities: Array<{ key: PlanActivityKey; label: string }>;
}

/**
 * Pure builder. Given the four EXISTS booleans + `isLatest`, returns
 * the structured envelope. Ordering: alphabetical by `key`. `'none'` is
 * mutually exclusive with the open-* keys.
 */
export function buildPlanActivityStatus(input: {
  isLatest: boolean;
  hasOpenPlanPhase: boolean;
  hasOpenEditDpr: boolean;
  hasOpenChangeDpr: boolean;
  hasOpenSupplement: boolean;
}): PlanActivityStatus {
  const freshness: PlanFreshnessKey = input.isLatest ? 'latest' : 'historical';
  const open: PlanActivityKey[] = [];
  if (input.hasOpenPlanPhase) open.push('submit-open');
  if (input.hasOpenEditDpr) open.push('edit-open');
  if (input.hasOpenChangeDpr) open.push('change-open');
  if (input.hasOpenSupplement) open.push('supplement-open');
  open.sort();

  const activities =
    open.length > 0
      ? open.map((k) => ({ key: k, label: resolveActivityLabel(k) }))
      : [{ key: 'none' as const, label: resolveActivityLabel('none') }];

  return {
    freshness,
    freshnessLabel: resolveFreshnessLabel(freshness),
    activities,
  };
}
