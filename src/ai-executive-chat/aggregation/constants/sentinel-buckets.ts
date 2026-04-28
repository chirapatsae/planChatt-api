/**
 * Wave 57 W57-BE-AGG-03 — Sentinel bucket keys + Thai labels for
 * project-level NULL handling in amphoe / อปท. / responsibleAgency
 * rollups.
 *
 * Per task §3 NULL handling:
 *   - `project.amphoe_id IS NULL` → `__province_level__`
 *     ("ระดับจังหวัด (ไม่จำเพาะอำเภอ)")
 *   - `project.local_administrative_organization_id IS NULL` →
 *     `__no_lao__` ("ไม่ระบุ อปท.")
 *   - `project.responsible_agency_id IS NULL` →
 *     `__pending_responsible_agency__` (per §5.2 LAO-origin pre-assignment;
 *     "ยังไม่มีหน่วยงานรับผิดชอบ (รอ staff กำหนด)")
 *
 * §17.2 advisory only — these buckets surface NULL state to the LLM
 * but do not gate any workflow transition. A row in the
 * `__pending_responsible_agency__` bucket has NOT been auto-assigned a
 * fabricated agency.
 */

export const SENTINEL_PROVINCE_LEVEL = '__province_level__' as const;
export const SENTINEL_PROVINCE_LEVEL_LABEL =
  'ระดับจังหวัด (ไม่จำเพาะอำเภอ)' as const;

export const SENTINEL_NO_LAO = '__no_lao__' as const;
export const SENTINEL_NO_LAO_LABEL = 'ไม่ระบุ อปท.' as const;

export const SENTINEL_PENDING_RESPONSIBLE_AGENCY =
  '__pending_responsible_agency__' as const;
export const SENTINEL_PENDING_RESPONSIBLE_AGENCY_LABEL =
  'ยังไม่มีหน่วยงานรับผิดชอบ (รอ staff กำหนด)' as const;

export type SentinelBucketKey =
  | typeof SENTINEL_PROVINCE_LEVEL
  | typeof SENTINEL_NO_LAO
  | typeof SENTINEL_PENDING_RESPONSIBLE_AGENCY;

export const SENTINEL_BUCKET_LABELS: Record<SentinelBucketKey, string> = {
  [SENTINEL_PROVINCE_LEVEL]: SENTINEL_PROVINCE_LEVEL_LABEL,
  [SENTINEL_NO_LAO]: SENTINEL_NO_LAO_LABEL,
  [SENTINEL_PENDING_RESPONSIBLE_AGENCY]:
    SENTINEL_PENDING_RESPONSIBLE_AGENCY_LABEL,
};

/**
 * Resolve a Thai label for a bucket key. Returns the sentinel label for
 * a known sentinel; otherwise the input unchanged. Use at the envelope
 * layer when surfacing buckets to the LLM.
 */
export function resolveBucketLabel(key: string): string {
  if (key in SENTINEL_BUCKET_LABELS) {
    return SENTINEL_BUCKET_LABELS[key as SentinelBucketKey];
  }
  return key;
}
