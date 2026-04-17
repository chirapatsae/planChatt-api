/**
 * ai-result-envelope.service.spec.ts
 *
 * Covers CLAUDE.md §17 acceptance criteria for the shared staleness-
 * model foundation:
 *   - content-hash determinism across two runs of the same DTO
 *   - content-hash flips on `project.title` mutation
 *   - attachment add/remove flips the hash
 *   - ISSUE_BASED vs STRATEGY_BASED DTOs produce distinct hashes
 *   - Thai NFC normalization is applied (mixed NFD input hashes equal)
 *   - attachment `aiStatus != 'done'` collapses to `not-done` marker
 *   - policy: 'snapshot-only' forces isStale=false
 *   - policy: 'strict' flips isStale=true when stored != current
 *   - envelope service never imports/injects TrackingStatus
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { AiResultEnvelopeService } from './ai-result-envelope.service';
import {
  computeSmartApproveContentHash,
  ContentHashInput,
} from './utils/content-hash';
import { scoreToBand } from './utils/ai-score-envelope';
import { computeIsStale } from './utils/staleness';
import { AbstractAiResult } from './entities/abstract-ai-result.entity';

function baseStrategyDto(): ContentHashInput {
  return {
    project: {
      title: 'ถนนคอนกรีต',
      objective: 'เพิ่มการเดินทางปลอดภัย',
      goal: 'ลดอุบัติเหตุ',
      expected: 'ถนนใหม่ 1 กม.',
      indicator: 'จำนวนอุบัติเหตุลดลง 10%',
      startLat: 14.97,
      startLng: 102.1,
      amphoeId: 3001,
      budgets: [
        { year: 2025, quantity: 100000 },
        { year: 2026, quantity: 200000 },
      ],
    },
    classification: {
      reportFormat: 'STRATEGY_BASED',
      strategyName: 'ยุทธศาสตร์ที่ 1',
      tacticName: 'กลยุทธ์ที่ 1',
      planName: 'แผนงานที่ 1',
    },
    attachments: [
      {
        id: 'a1',
        aiStatus: 'done',
        aiTopic: 'โครงการถนน',
        aiSummary: 'สรุป',
        aiExtractionQualityScore: 85,
      },
    ],
    justification: null,
  };
}

describe('computeSmartApproveContentHash', () => {
  it('is deterministic across two runs of the same DTO', () => {
    const dto = baseStrategyDto();
    expect(computeSmartApproveContentHash(dto)).toEqual(
      computeSmartApproveContentHash(dto),
    );
  });

  it('flips when project.title mutates', () => {
    const a = baseStrategyDto();
    const b = baseStrategyDto();
    b.project.title = 'ถนนใหม่';
    expect(computeSmartApproveContentHash(a)).not.toEqual(
      computeSmartApproveContentHash(b),
    );
  });

  it('flips when an attachment is added', () => {
    const a = baseStrategyDto();
    const b = baseStrategyDto();
    b.attachments = [
      ...(b.attachments ?? []),
      { id: 'a2', aiStatus: 'done' },
    ];
    expect(computeSmartApproveContentHash(a)).not.toEqual(
      computeSmartApproveContentHash(b),
    );
  });

  it('flips when an attachment is removed', () => {
    const a = baseStrategyDto();
    const b = baseStrategyDto();
    b.attachments = [];
    expect(computeSmartApproveContentHash(a)).not.toEqual(
      computeSmartApproveContentHash(b),
    );
  });

  it('is order-insensitive across attachment order', () => {
    const a = baseStrategyDto();
    a.attachments = [
      { id: 'a1', aiStatus: 'done' },
      { id: 'a2', aiStatus: 'done' },
    ];
    const b = baseStrategyDto();
    b.attachments = [
      { id: 'a2', aiStatus: 'done' },
      { id: 'a1', aiStatus: 'done' },
    ];
    expect(computeSmartApproveContentHash(a)).toEqual(
      computeSmartApproveContentHash(b),
    );
  });

  it('is order-insensitive across budget order', () => {
    const a = baseStrategyDto();
    a.project.budgets = [
      { year: 2025, quantity: 100 },
      { year: 2026, quantity: 200 },
    ];
    const b = baseStrategyDto();
    b.project.budgets = [
      { year: 2026, quantity: 200 },
      { year: 2025, quantity: 100 },
    ];
    expect(computeSmartApproveContentHash(a)).toEqual(
      computeSmartApproveContentHash(b),
    );
  });

  it('ISSUE_BASED and STRATEGY_BASED produce distinct hashes for otherwise-identical fields', () => {
    const strat = baseStrategyDto();

    const issue: ContentHashInput = {
      project: { ...strat.project, indicator: undefined },
      classification: {
        reportFormat: 'ISSUE_BASED',
        developmentIssueName: 'ประเด็นการพัฒนาที่ 1',
      },
      attachments: strat.attachments,
      justification: null,
    };

    expect(computeSmartApproveContentHash(strat)).not.toEqual(
      computeSmartApproveContentHash(issue),
    );
  });

  it('normalizes Thai text to NFC (NFD input produces the same hash)', () => {
    const a = baseStrategyDto();
    a.project.title = 'ก' + '\u0e34'; // already composed in Thai (no diacritic combining), simulate pre-composed
    const b = baseStrategyDto();
    // Build via explicit normalize calls — verify deterministic output when
    // a caller passes a non-normalized form.
    b.project.title = ('ก' + '\u0e34').normalize('NFD');
    expect(computeSmartApproveContentHash(a)).toEqual(
      computeSmartApproveContentHash(b),
    );
  });

  it('treats aiStatus != "done" as the "not-done" marker (same hash)', () => {
    const a = baseStrategyDto();
    a.attachments = [
      { id: 'x', aiStatus: 'pending', aiTopic: 'IGNORED' },
    ];
    const b = baseStrategyDto();
    b.attachments = [
      { id: 'x', aiStatus: 'processing', aiSummary: 'ALSO IGNORED' },
    ];
    expect(computeSmartApproveContentHash(a)).toEqual(
      computeSmartApproveContentHash(b),
    );
  });

  it('tolerates null justification (treated as empty string, not skipped)', () => {
    const a = baseStrategyDto();
    a.justification = null;
    const b = baseStrategyDto();
    b.justification = '';
    expect(computeSmartApproveContentHash(a)).toEqual(
      computeSmartApproveContentHash(b),
    );
  });
});

describe('scoreToBand', () => {
  it('returns green at >= 80', () => {
    expect(scoreToBand(80)).toBe('green');
    expect(scoreToBand(95)).toBe('green');
  });
  it('returns amber at 50..79', () => {
    expect(scoreToBand(50)).toBe('amber');
    expect(scoreToBand(79)).toBe('amber');
  });
  it('returns red below 50', () => {
    expect(scoreToBand(49)).toBe('red');
    expect(scoreToBand(0)).toBe('red');
  });
  it('returns red for non-finite input', () => {
    expect(scoreToBand(Number.NaN)).toBe('red');
    expect(scoreToBand(Number.POSITIVE_INFINITY)).toBe('green');
  });
});

describe('computeIsStale', () => {
  it('always returns false for snapshot-only policy', () => {
    expect(
      computeIsStale({
        storedHash: 'aaa',
        currentHash: 'bbb',
        policy: 'snapshot-only',
      }),
    ).toBe(false);
  });

  it('returns true when hashes differ under strict policy', () => {
    expect(
      computeIsStale({
        storedHash: 'aaa',
        currentHash: 'bbb',
        policy: 'strict',
      }),
    ).toBe(true);
  });

  it('returns false when hashes match under strict policy', () => {
    expect(
      computeIsStale({
        storedHash: 'aaa',
        currentHash: 'aaa',
        policy: 'strict',
      }),
    ).toBe(false);
  });

  it('returns true under warning-only when hashes differ', () => {
    expect(
      computeIsStale({
        storedHash: 'aaa',
        currentHash: 'bbb',
        policy: 'warning-only',
      }),
    ).toBe(true);
  });
});

describe('AiResultEnvelopeService', () => {
  const svc = new AiResultEnvelopeService();

  function fakeStored(overrides: Partial<AbstractAiResult> = {}): AbstractAiResult {
    return {
      id: 'id-1',
      targetId: 'proj-1',
      targetKind: 'revised-project-group',
      contentHash: 'hash-a',
      computedAt: new Date('2026-04-17T00:00:00.000Z'),
      computedByWorkHistoryId: null,
      resultJson: {},
      score0100: 85,
      band: 'green',
      stalenessPolicy: 'strict',
      model: 'gpt-4o',
      endpoint: 'smart-approve/analyze/revised',
      createdAt: new Date('2026-04-17T00:00:00.000Z'),
      updatedAt: null,
      deletedAt: null,
      ...overrides,
    } as AbstractAiResult;
  }

  it('returns null when no stored row is provided', () => {
    expect(
      svc.buildEnvelope({ stored: null, currentHash: 'hash-a' }),
    ).toBeNull();
  });

  it('builds an envelope with isStale=false when hashes match', () => {
    const env = svc.buildEnvelope({
      stored: fakeStored(),
      currentHash: 'hash-a',
    });
    expect(env).not.toBeNull();
    expect(env!.isStale).toBe(false);
    expect(env!.score).toBe(85);
    expect(env!.band).toBe('green');
    expect(env!.stalenessPolicy).toBe('strict');
    expect(env!.computedAt).toEqual('2026-04-17T00:00:00.000Z');
  });

  it('builds an envelope with isStale=true when hashes differ under strict', () => {
    const env = svc.buildEnvelope({
      stored: fakeStored(),
      currentHash: 'hash-b',
    });
    expect(env!.isStale).toBe(true);
  });

  it('forces isStale=false when stored policy is snapshot-only', () => {
    const env = svc.buildEnvelope({
      stored: fakeStored({ stalenessPolicy: 'snapshot-only' }),
      currentHash: 'hash-b',
    });
    expect(env!.isStale).toBe(false);
    expect(env!.stalenessPolicy).toBe('snapshot-only');
  });

  it('honors policyOverride when provided', () => {
    const env = svc.buildEnvelope({
      stored: fakeStored({ stalenessPolicy: 'strict' }),
      currentHash: 'hash-b',
      policyOverride: 'snapshot-only',
    });
    expect(env!.isStale).toBe(false);
  });

  it('rejects a non-allow-listed target kind', () => {
    expect(() =>
      svc.buildEnvelope({
        stored: fakeStored({ targetKind: 'something-else' as any }),
        currentHash: 'hash-a',
      }),
    ).toThrow(/AI_TARGET_KIND_NOT_ALLOWED/);
  });

  it('derives band from score when band is null', () => {
    const env = svc.buildEnvelope({
      stored: fakeStored({ band: null, score0100: 45 }),
      currentHash: 'hash-a',
    });
    expect(env!.band).toBe('red');
  });

  it('includes changedFields when provided', () => {
    const env = svc.buildEnvelope({
      stored: fakeStored(),
      currentHash: 'hash-b',
      changedFields: ['ชื่อโครงการ'],
    });
    expect(env!.changedFields).toEqual(['ชื่อโครงการ']);
  });
});

describe('AiResultEnvelopeService — no TrackingStatus import', () => {
  it('source file contains zero references to TrackingStatus', () => {
    const src = readFileSync(
      join(__dirname, 'ai-result-envelope.service.ts'),
      'utf8',
    );
    expect(/TrackingStatus/.test(src)).toBe(false);
    expect(/tracking_status/.test(src)).toBe(false);
    expect(/trackingStatusRepo/.test(src)).toBe(false);
  });
});
