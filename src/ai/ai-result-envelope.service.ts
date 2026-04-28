/**
 * ai-result-envelope.service.ts — Shared read-side helper that composes
 * `AiScoreEnvelope` objects from a stored `AbstractAiResult` row and the
 * current live hash.
 *
 * CLAUDE.md §17.3 + §17.4 + §17.10.
 *
 * Constraints:
 *   - MUST NOT import or inject any tracking-status-audit symbol (§12 + §17.3).
 *   - MUST NOT write to any project-owning table (§17.3).
 *   - MUST NOT bypass per-result `stalenessPolicy`.
 *   - Validates `target_kind` against the §17.3 allow-list.
 *
 * This service is read-only. It formats previously-stored rows into the
 * canonical envelope downstream UI consumes. Downstream RF2 / RF5
 * services own the write side.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { AbstractAiResult } from './entities/abstract-ai-result.entity';
import {
  AiResultTargetKind,
  AiScoreBand,
  AiScoreEnvelope,
  AiStalenessPolicy,
  scoreToBand,
} from './utils/ai-score-envelope';
import { computeIsStale } from './utils/staleness';

const ALLOWED_TARGET_KINDS: AiResultTargetKind[] = [
  'project-group',
  'revised-project-group',
  'supplement-project-group',
];

export interface BuildEnvelopeArgs {
  /** Persisted AI result row (any subclass of AbstractAiResult). */
  stored: AbstractAiResult | null | undefined;
  /** Live content hash recomputed from the current DTO. */
  currentHash: string | null | undefined;
  /**
   * Optional policy override. When omitted, the stored row's
   * `stalenessPolicy` is used. RF5 callers MAY pass `'snapshot-only'`
   * explicitly to defend against a mis-persisted row.
   */
  policyOverride?: AiStalenessPolicy;
  /**
   * Best-effort list of Thai-labelled changed fields. Optional — when
   * omitted, the envelope's `changedFields` is left undefined.
   */
  changedFields?: string[];
}

@Injectable()
export class AiResultEnvelopeService {
  /**
   * Build a canonical `AiScoreEnvelope` for downstream controllers.
   *
   * Returns `null` when there is no stored row to envelope (caller
   * decides whether to render an "no-result-yet" state).
   */
  buildEnvelope(args: BuildEnvelopeArgs): AiScoreEnvelope | null {
    const stored = args.stored;
    if (!stored) return null;

    this.assertTargetKindAllowed(stored.targetKind);

    const policy: AiStalenessPolicy =
      args.policyOverride ?? stored.stalenessPolicy;

    const isStale = computeIsStale({
      storedHash: stored.contentHash,
      currentHash: args.currentHash,
      policy,
    });

    const band: AiScoreBand | null = this.resolveBand(stored);

    const envelope: AiScoreEnvelope = {
      score: stored.score0100 ?? null,
      band,
      computedAt: this.toIsoString(stored.computedAt),
      contentHash: stored.contentHash,
      isStale,
      model: stored.model,
      endpoint: stored.endpoint,
      stalenessPolicy: policy,
    };

    if (args.changedFields && args.changedFields.length > 0) {
      envelope.changedFields = args.changedFields.slice();
    }

    return envelope;
  }

  private resolveBand(stored: AbstractAiResult): AiScoreBand | null {
    // Prefer the explicitly-stored band, fall back to recomputing from
    // score. If neither is available, null.
    if (stored.band) return stored.band;
    if (typeof stored.score0100 === 'number') {
      return scoreToBand(stored.score0100);
    }
    return null;
  }

  private toIsoString(value: Date | string | null | undefined): string {
    if (!value) return new Date(0).toISOString();
    if (value instanceof Date) return value.toISOString();
    // TypeORM may return a string for timestamptz on some drivers.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return new Date(0).toISOString();
    return d.toISOString();
  }

  private assertTargetKindAllowed(kind: AiResultTargetKind | null): void {
    // Wave 46 hotfix: `AbstractAiResult.targetKind` widened to
    // `AiResultTargetKind | null` to accommodate chat turns
    // (§17.3 / BE-W45-01). Per-project AI-result rows (RF2/RF5)
    // always carry a non-null kind at write time; a null here is
    // a caller-side bug — reject explicitly.
    if (kind === null) {
      throw new BadRequestException('AI_TARGET_KIND_NOT_ALLOWED: null');
    }
    if (!ALLOWED_TARGET_KINDS.includes(kind)) {
      // Defensive — prevents downstream RFs from accidentally enveloping
      // arbitrary entity kinds (§9 security constraint).
      throw new BadRequestException(
        `AI_TARGET_KIND_NOT_ALLOWED: ${String(kind)}`,
      );
    }
  }
}
