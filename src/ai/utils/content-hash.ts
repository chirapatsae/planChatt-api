/**
 * content-hash.ts — Canonical content-hash computation for AI-scoped inputs.
 *
 * Part of the Staff-AI staleness-model foundation (CLAUDE.md §17.4).
 *
 * Contract:
 *   - Inputs are NFC-normalized before hashing (Thai-text stability).
 *   - Array fields are order-insensitive (sorted deterministically before
 *     hashing) so that UI reordering does not flip the hash.
 *   - Branches on `reportFormat` per CLAUDE.md §16.5 — STRATEGY_BASED vs
 *     ISSUE_BASED produce distinct hashes even when sharing text fields.
 *   - Attachments whose OCR is not `done` are represented only by their
 *     id + a `not-done` marker, so the hash deliberately flips once OCR
 *     completes (§17.4 intentional recompute signal).
 *   - The output is a lowercase SHA-256 hex string.
 *
 * Security:
 *   - NEVER include PII fields (email, phone, idCardNumber) in the hash
 *     input. The DTO used here does not carry these fields. If callers
 *     extend the DTO, they MUST strip PII before passing it in.
 *
 * This module does NOT import TypeORM, Nest, any tracking-status-audit
 * symbol, or any project-entity type. It is a pure utility.
 */
import { createHash } from 'crypto';

export type ReportFormatLike = 'STRATEGY_BASED' | 'ISSUE_BASED';

/**
 * Minimal DTO shape accepted by the hash function.
 * Kept loose intentionally — downstream RF2/RF5 may populate a subset.
 */
export interface ContentHashProjectInput {
  title?: string | null;
  objective?: string | null;
  goal?: string | null;
  expected?: string | null;
  indicator?: string | null;
  startLat?: number | null;
  startLng?: number | null;
  endLat?: number | null;
  endLng?: number | null;
  amphoeId?: number | string | null;
  localOrganizationId?: number | string | null;
  budgets?: Array<{ year: number; quantity: number } | null | undefined>;
  /**
   * Wave Equipment ผ.03 Phase 2 — BE-06 (2026-05-28). Equipment-only
   * discriminator. Included in the canonical hash so that an equipment
   * row's category is a deterministic part of `(target_kind, target_id,
   * content_hash)`. The slot is `undefined` for every PG / RPG / SPG
   * call site and therefore produces the same hash as before — see the
   * canonicalizer below for the "omit when nullish" behavior.
   */
  equipmentCategoryId?: string | null;
}

export interface ContentHashClassificationInput {
  reportFormat: ReportFormatLike;
  strategyName?: string | null;
  tacticName?: string | null;
  planName?: string | null;
  developmentIssueName?: string | null;
}

export interface ContentHashAttachmentInput {
  id: string;
  aiStatus?: string | null;
  aiTopic?: string | null;
  aiSummary?: string | null;
  aiExtractionQualityScore?: number | null;
}

export interface ContentHashInput {
  project: ContentHashProjectInput;
  classification: ContentHashClassificationInput;
  attachments?: ContentHashAttachmentInput[] | null;
  justification?: string | null;
}

/**
 * NFC-normalize a string. Null / undefined → empty string.
 * Trimming applied defensively before normalization.
 */
function normalizeString(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  const s = String(value).trim();
  // String.prototype.normalize is available in Node 12+; Node 18+ is baseline.
  return s.normalize('NFC');
}

function normalizeNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return value;
}

function normalizeId(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function canonicalizeClassification(
  c: ContentHashClassificationInput,
): Record<string, unknown> {
  // Format key lower-cased per task contract §7.1.
  const reportFormat = c.reportFormat;
  if (reportFormat === 'ISSUE_BASED') {
    return {
      reportFormat: 'issue_based',
      developmentIssueName: normalizeString(c.developmentIssueName),
    };
  }
  // STRATEGY_BASED (default / legacy).
  return {
    reportFormat: 'strategy_based',
    strategyName: normalizeString(c.strategyName),
    tacticName: normalizeString(c.tacticName),
    planName: normalizeString(c.planName),
  };
}

function canonicalizeProject(
  p: ContentHashProjectInput,
  reportFormat: ReportFormatLike,
): Record<string, unknown> {
  const budgets = Array.isArray(p.budgets)
    ? p.budgets
        .filter((b): b is { year: number; quantity: number } => !!b)
        .map((b) => ({
          year: Number(b.year),
          quantity: Number(b.quantity),
        }))
        // Order-insensitive: sort by year ascending, then quantity.
        .sort((a, b) => {
          if (a.year !== b.year) return a.year - b.year;
          return a.quantity - b.quantity;
        })
    : [];

  const base: Record<string, unknown> = {
    title: normalizeString(p.title),
    objective: normalizeString(p.objective),
    goal: normalizeString(p.goal),
    expected: normalizeString(p.expected),
    startLat: normalizeNumber(p.startLat),
    startLng: normalizeNumber(p.startLng),
    endLat: normalizeNumber(p.endLat),
    endLng: normalizeNumber(p.endLng),
    amphoeId: normalizeId(p.amphoeId),
    localOrganizationId: normalizeId(p.localOrganizationId),
    budgets,
  };

  // §16.5 classification-shape invariant — indicator only for STRATEGY_BASED.
  if (reportFormat === 'STRATEGY_BASED') {
    base.indicator = normalizeString(p.indicator);
  }

  // Wave Equipment ผ.03 Phase 2 — BE-06 (2026-05-28). Equipment-only
  // discriminator. The key is OMITTED entirely when the caller does not
  // supply a category id (every existing PG / RPG / SPG call site). This
  // preserves existing hash output byte-for-byte for non-equipment
  // targets — critical for Wave 10 same-hash idempotency on already-
  // persisted snapshot rows.
  const equipmentCategoryId = normalizeId(p.equipmentCategoryId);
  if (equipmentCategoryId !== null) {
    base.equipmentCategoryId = equipmentCategoryId;
  }

  return base;
}

function canonicalizeAttachments(
  attachments: ContentHashAttachmentInput[] | null | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  return attachments
    .filter((a): a is ContentHashAttachmentInput => !!a && !!a.id)
    .map((a) => {
      const status = normalizeString(a.aiStatus).toLowerCase();
      if (status !== 'done') {
        // When OCR not finished, collapse to minimal marker so that
        // completing OCR LATER legitimately flips the hash.
        return { id: String(a.id), aiStatus: 'not-done' };
      }
      return {
        id: String(a.id),
        aiStatus: 'done',
        aiTopic: normalizeString(a.aiTopic),
        aiSummary: normalizeString(a.aiSummary),
        aiExtractionQualityScore:
          typeof a.aiExtractionQualityScore === 'number' &&
          !Number.isNaN(a.aiExtractionQualityScore)
            ? a.aiExtractionQualityScore
            : null,
      };
    })
    // Order-insensitive across the array.
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Deterministically stringifies an object with sorted keys at every depth.
 * Arrays are left in caller-supplied order (callers sort beforehand).
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
        .join(',') +
      '}'
    );
  }
  return 'null';
}

/**
 * Compute the canonical SHA-256 content hash for an AI smart-approve input.
 *
 * The output is a lowercase hex string (64 chars).
 */
export function computeSmartApproveContentHash(input: ContentHashInput): string {
  const classification = canonicalizeClassification(input.classification);
  const project = canonicalizeProject(
    input.project,
    input.classification.reportFormat,
  );
  const attachments = canonicalizeAttachments(input.attachments);
  // §11 Risks / Edge Cases: null justification collapses to empty string.
  const justification = normalizeString(input.justification);

  const canonical = {
    version: 1,
    classification,
    project,
    attachments,
    justification,
  };

  const payload = stableStringify(canonical);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
