/**
 * staleness.ts — Staleness detection helper for AI results.
 *
 * Part of the Staff-AI staleness-model foundation (CLAUDE.md §17.4).
 *
 * Exposes:
 *   - computeIsStale({ storedHash, currentHash, policy })
 *       → true when a `strict`- or `warning-only`-policy result's content
 *         hash no longer matches the live input.
 *       → always false for `snapshot-only` (RF5 photograph-at-submit-time).
 *   - summarizeStaleFields(prev, current)
 *       → Thai-labelled list of field keys whose values differ between
 *         the stored DTO and the current DTO. Best-effort only.
 *
 * No TypeORM / Nest imports.
 */
import {
  AiStalenessPolicy,
  AiScoreEnvelope,
} from './ai-score-envelope';
import {
  ContentHashInput,
  ContentHashProjectInput,
  ContentHashAttachmentInput,
  ContentHashClassificationInput,
} from './content-hash';

export interface ComputeIsStaleArgs {
  storedHash: string | null | undefined;
  currentHash: string | null | undefined;
  policy: AiStalenessPolicy;
}

/**
 * Determine whether a stored AI result is stale.
 *
 * Rules (§17.4):
 *   - `snapshot-only` → always `false` (by design).
 *   - `strict` / `warning-only` → `true` when hashes differ OR either
 *     hash is missing (defensive — missing stored hash treated as stale
 *     to avoid presenting a potentially-mismatched result as fresh).
 */
export function computeIsStale(args: ComputeIsStaleArgs): boolean {
  const { storedHash, currentHash, policy } = args;
  if (policy === 'snapshot-only') return false;

  if (!storedHash || !currentHash) return true;
  return storedHash !== currentHash;
}

/**
 * Thai field labels used in `summarizeStaleFields`. Intentionally kept
 * here (backend) as a small mirror of the frontend copy module, because
 * the envelope ships these strings directly in the API payload.
 */
const THAI_FIELD_LABELS: Record<string, string> = {
  title: 'ชื่อโครงการ',
  objective: 'วัตถุประสงค์',
  goal: 'เป้าหมาย',
  expected: 'ผลที่คาดว่าจะได้รับ',
  indicator: 'ตัวชี้วัด',
  startLat: 'พิกัดเริ่มต้น (lat)',
  startLng: 'พิกัดเริ่มต้น (lng)',
  endLat: 'พิกัดสิ้นสุด (lat)',
  endLng: 'พิกัดสิ้นสุด (lng)',
  amphoeId: 'อำเภอ',
  localOrganizationId: 'หน่วยงาน อปท.',
  budgets: 'งบประมาณ',
  strategyName: 'ยุทธศาสตร์',
  tacticName: 'กลยุทธ์',
  planName: 'แผนงาน',
  developmentIssueName: 'ประเด็นการพัฒนา',
  attachments: 'ไฟล์แนบ',
  justification: 'เหตุผลประกอบ',
};

function scalarEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function budgetsEqual(
  a: ContentHashProjectInput['budgets'],
  b: ContentHashProjectInput['budgets'],
): boolean {
  const left = Array.isArray(a) ? [...a] : [];
  const right = Array.isArray(b) ? [...b] : [];
  if (left.length !== right.length) return false;
  const norm = (list: typeof left) =>
    list
      .filter((x): x is { year: number; quantity: number } => !!x)
      .map((x) => `${x.year}:${x.quantity}`)
      .sort();
  const l = norm(left);
  const r = norm(right);
  if (l.length !== r.length) return false;
  for (let i = 0; i < l.length; i++) if (l[i] !== r[i]) return false;
  return true;
}

function attachmentsEqual(
  a: ContentHashAttachmentInput[] | null | undefined,
  b: ContentHashAttachmentInput[] | null | undefined,
): boolean {
  const la = Array.isArray(a) ? a : [];
  const lb = Array.isArray(b) ? b : [];
  if (la.length !== lb.length) return false;
  const toKey = (x: ContentHashAttachmentInput) =>
    [
      String(x.id ?? ''),
      String(x.aiStatus ?? ''),
      String(x.aiTopic ?? ''),
      String(x.aiSummary ?? ''),
      String(x.aiExtractionQualityScore ?? ''),
    ].join('|');
  const sa = la.map(toKey).sort();
  const sb = lb.map(toKey).sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Produce a best-effort list of Thai-labelled field keys whose values
 * differ between a previously-hashed DTO and the current DTO.
 *
 * Intended for UI hint text. The backend MUST NOT rely on this list for
 * any gating logic — staleness is computed by hash comparison, not by
 * field diff.
 */
export function summarizeStaleFields(
  prev: ContentHashInput | null | undefined,
  current: ContentHashInput | null | undefined,
): string[] {
  if (!prev || !current) return [];

  const changed: string[] = [];

  // Classification (§16.5 shape-aware).
  const classKeys: Array<keyof ContentHashClassificationInput> = [
    'strategyName',
    'tacticName',
    'planName',
    'developmentIssueName',
  ];
  if (prev.classification.reportFormat !== current.classification.reportFormat) {
    // Shape-level change — surface as classification-level delta.
    changed.push(THAI_FIELD_LABELS.strategyName);
  } else {
    for (const k of classKeys) {
      if (!scalarEqual(prev.classification[k], current.classification[k])) {
        const label = THAI_FIELD_LABELS[k as string];
        if (label && !changed.includes(label)) changed.push(label);
      }
    }
  }

  // Project scalar fields.
  const scalarKeys: Array<keyof ContentHashProjectInput> = [
    'title',
    'objective',
    'goal',
    'expected',
    'indicator',
    'startLat',
    'startLng',
    'endLat',
    'endLng',
    'amphoeId',
    'localOrganizationId',
  ];
  for (const k of scalarKeys) {
    if (!scalarEqual(prev.project[k], current.project[k])) {
      const label = THAI_FIELD_LABELS[k as string];
      if (label && !changed.includes(label)) changed.push(label);
    }
  }

  // Budgets — order-insensitive comparison.
  if (!budgetsEqual(prev.project.budgets, current.project.budgets)) {
    const label = THAI_FIELD_LABELS.budgets;
    if (label && !changed.includes(label)) changed.push(label);
  }

  // Attachments.
  if (!attachmentsEqual(prev.attachments, current.attachments)) {
    const label = THAI_FIELD_LABELS.attachments;
    if (label && !changed.includes(label)) changed.push(label);
  }

  // Justification.
  if (!scalarEqual(prev.justification ?? '', current.justification ?? '')) {
    const label = THAI_FIELD_LABELS.justification;
    if (label && !changed.includes(label)) changed.push(label);
  }

  return changed;
}

/**
 * Convenience: resolve the final envelope-level `isStale` for a stored
 * AI result row given the current hash.
 *
 * Intended for use by `AiResultEnvelopeService` and downstream RF2/RF5
 * controllers. Does not perform any I/O.
 */
export function resolveEnvelopeStaleness(params: {
  storedHash: string | null | undefined;
  currentHash: string | null | undefined;
  policy: AiStalenessPolicy;
}): Pick<AiScoreEnvelope, 'isStale' | 'stalenessPolicy'> {
  return {
    isStale: computeIsStale(params),
    stalenessPolicy: params.policy,
  };
}
