import { IssueCriteriaGeoCheckService } from './issue-criteria-geo-check.service';
import {
  IssueCriteriaEvidenceCheckService,
  EvidenceAttachmentInput,
} from './issue-criteria-evidence-check.service';
import { GeoBoundaryService } from '../geo-boundary.service';
import { CriterionHint, IssueRuleEntry } from './issue-criteria.types';
import { NAKHON_RATCHASIMA_ISSUE_RULES } from './nakhon-ratchasima-issue-rules';

/**
 * Wave LAO+STRATEGY_BASED AI parity — N5 hint-service unit tests.
 *
 * Scope:
 *   - Verify that geo / evidence hint services stamp `issueKey` on
 *     every CriterionHint they emit (multi-entry attribution prereq).
 *   - Verify that ISSUE_BASED single-entry output preserved byte-for-
 *     byte aside from the new `issueKey` stamp.
 *   - Verify STRAT003 multi-entry usage: hints from BOTH economic-3-1
 *     and economic-3-2 collected, each tagged with its own issueKey,
 *     geo-auto hard-override precedence preserved.
 *
 * Advisory-only per CLAUDE.md §17.2 — these tests assert advisory
 * data shape only; no workflow-gate assertions.
 */

const economic31 = NAKHON_RATCHASIMA_ISSUE_RULES.find(
  (e) => e.issueKey === 'economic-3-1',
) as IssueRuleEntry;
const economic32 = NAKHON_RATCHASIMA_ISSUE_RULES.find(
  (e) => e.issueKey === 'economic-3-2',
) as IssueRuleEntry;
const royalInitiated = NAKHON_RATCHASIMA_ISSUE_RULES.find(
  (e) => e.issueKey === 'royal-initiated',
) as IssueRuleEntry;

describe('IssueCriteriaGeoCheckService — issueKey stamping (N5)', () => {
  let service: IssueCriteriaGeoCheckService;
  // Mock GeoBoundaryService — only `resolveAmphoeForPoint` is consumed.
  // Return distinct codes so the cross-amphoe branch fires `pass`.
  const geoMock = {
    resolveAmphoeForPoint: (lat: number, _lng: number) => ({
      // start point lat=14 -> amphoe A; end point lat=15 -> amphoe B
      amphoeCode: lat < 14.5 ? 'A001' : 'B002',
    }),
  } as unknown as GeoBoundaryService;

  beforeEach(() => {
    service = new IssueCriteriaGeoCheckService(geoMock);
  });

  it('Test 1 — ISSUE_BASED single-entry: hints carry issueKey === entry.issueKey', () => {
    const hints = service.evaluate(economic32, {
      startLat: 14.0,
      startLng: 102.0,
      endLat: 15.0,
      endLng: 102.5,
    });
    // economic-3-2 declares ONE cross-amphoe criterion (C3_2.a)
    expect(hints.length).toBe(1);
    expect(hints[0].criterionId).toBe('C3_2.a');
    expect(hints[0].kind).toBe('geo-auto');
    expect(hints[0].hardOverride).toBe(true);
    expect(hints[0].suggestedVerdict).toBe('pass');
    // §17.4 attribution: issueKey stamped on every emitted hint
    expect(hints[0].issueKey).toBe('economic-3-2');
  });

  it('Test 2 — STRAT003 multi-entry: collect hints from both economic entries, each tagged', () => {
    const coords = {
      startLat: 14.0,
      startLng: 102.0,
      endLat: 15.0,
      endLng: 102.5,
    };
    // STRATEGY_BASED parity path: caller iterates per matched entry.
    const hintsFrom31 = service.evaluate(economic31, coords);
    const hintsFrom32 = service.evaluate(economic32, coords);
    const merged = [...hintsFrom31, ...hintsFrom32];

    // economic-3-1 has NO cross-amphoe criterion; economic-3-2 has one.
    expect(hintsFrom31.length).toBe(0);
    expect(hintsFrom32.length).toBe(1);
    expect(merged.length).toBe(1);
    // Verdict-precedence preserved (geo-auto hardOverride):
    expect(merged.every((h) => h.kind === 'geo-auto')).toBe(true);
    expect(merged.every((h) => h.hardOverride === true)).toBe(true);
    // Each hint tagged with its source entry's issueKey:
    expect(merged.find((h) => h.criterionId === 'C3_2.a')?.issueKey).toBe(
      'economic-3-2',
    );
  });

  it('Test 5 — N=1 byte-identity regression: shape unchanged except for new issueKey field', () => {
    // royal-initiated has zero cross-amphoe criteria → empty hints,
    // confirming the entry-shape that does not opt into geo-auto is
    // unaffected.
    const hints = service.evaluate(royalInitiated, {
      startLat: 14.0,
      startLng: 102.0,
      endLat: 15.0,
      endLng: 102.5,
    });
    expect(hints).toEqual([]);

    // For economic-3-2 (single-entry baseline ISSUE_BASED behaviour),
    // strip `issueKey` and assert the rest of the hint is unchanged
    // from the pre-N5 shape (criterionId / suggestedVerdict / reason /
    // kind / hardOverride / evidenceLink).
    const [hint] = service.evaluate(economic32, {
      startLat: 14.0,
      startLng: 102.0,
      endLat: 15.0,
      endLng: 102.5,
    });
    expect(hint).toBeDefined();
    const { issueKey, ...preN5Shape } = hint;
    expect(issueKey).toBe('economic-3-2');
    expect(preN5Shape).toEqual({
      criterionId: 'C3_2.a',
      suggestedVerdict: 'pass',
      reason: expect.stringContaining('คาบเกี่ยว'),
      kind: 'geo-auto',
      hardOverride: true,
    });
  });
});

describe('IssueCriteriaEvidenceCheckService — issueKey stamping (N5)', () => {
  let service: IssueCriteriaEvidenceCheckService;

  beforeEach(() => {
    service = new IssueCriteriaEvidenceCheckService();
  });

  it('Test 3 — evidence-auto pass hint stamped with source entry issueKey', () => {
    const attachments: EvidenceAttachmentInput[] = [
      {
        id: 'att-1',
        aiTopic: 'หนังสืออนุญาตใช้พื้นที่จากกรมป่าไม้',
        aiSummary: 'เอกสารแนบ ขออนุญาตใช้พื้นที่ ครบถ้วน',
        evidenceLink: '/api/v1/attachment-project-groups/att-1',
      },
    ];
    const hints = service.evaluate(economic32, attachments);
    // economic-3-2 has 2 evidence-required criteria (C3_2.c, C3_2.d);
    // both should emit hints — at least one should pass.
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(h.kind).toBe('evidence-auto');
      // N5 attribution: every evidence-auto hint stamps its source.
      expect(h.issueKey).toBe('economic-3-2');
    }
    const passHints = hints.filter((h) => h.suggestedVerdict === 'pass');
    expect(passHints.length).toBeGreaterThan(0);
  });

  it('Test 4 — evidence-auto needs-evidence (no match) hint still carries issueKey', () => {
    // Attachment with no matching keyword → all evidence criteria emit
    // `needs-evidence` hints. issueKey MUST still be stamped.
    const attachments: EvidenceAttachmentInput[] = [
      {
        id: 'att-2',
        aiTopic: 'ไม่เกี่ยวข้อง',
        aiSummary: 'เอกสารทั่วไป',
        evidenceLink: null,
      },
    ];
    const hints = service.evaluate(economic32, attachments);
    expect(hints.length).toBeGreaterThan(0);
    expect(
      hints.every((h) => h.suggestedVerdict === 'needs-evidence'),
    ).toBe(true);
    expect(hints.every((h) => h.issueKey === 'economic-3-2')).toBe(true);
    expect(hints.every((h) => h.kind === 'evidence-auto')).toBe(true);
    expect(hints.every((h) => h.hardOverride === false)).toBe(true);
  });

  it('Empty hints when entry has no evidenceRequired criteria', () => {
    // royal-initiated has 3 advisory/preferred criteria with no
    // evidenceTags → evidence check produces zero hints.
    const hints = service.evaluate(royalInitiated, []);
    expect(hints).toEqual([]);
  });
});

describe('Multi-entry hint merge invariant (N5 integration sketch)', () => {
  /**
   * Light-weight sanity check that downstream N3 callers iterate per
   * matched entry and concatenate. The merger contract (per task §6.1)
   * partitions hints by `issueKey`. This block asserts the input shape
   * the merger will rely on.
   */
  it('hints from N entries form a flat array whose elements all carry a valid issueKey', () => {
    const evidenceSvc = new IssueCriteriaEvidenceCheckService();
    const entries: IssueRuleEntry[] = [economic31, economic32];
    const empties: EvidenceAttachmentInput[] = [];
    const allHints: CriterionHint[] = [];
    for (const entry of entries) {
      allHints.push(...evidenceSvc.evaluate(entry, empties));
    }
    // Every emitted hint resolves to one of the input entry keys.
    const validKeys = new Set(entries.map((e) => e.issueKey));
    for (const h of allHints) {
      expect(h.issueKey).toBeDefined();
      expect(validKeys.has(h.issueKey!)).toBe(true);
    }
  });
});
