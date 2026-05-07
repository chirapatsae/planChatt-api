/**
 * Wave 57 W57-BE-AGG-02 — Origin-type helper unit spec.
 *
 * CLAUDE.md references:
 *   - §1 — agency iff amphoe.id === '3001' AND LAO.id === '3001027'.
 *   - §5 — `originType` is derived from creator WH at creation time
 *     and is immutable. Re-classifying based on the project's CURRENT
 *     creator WH would be wrong; aggregator MUST use the WH FK.
 */
import {
  PAO_AMPHOE_ID,
  PAO_LAO_ID,
  classifyOriginFromIdScalars,
  classifyOriginFromWorkHistory,
} from '../helpers/origin-type';

describe('W57-BE-AGG-02 / classifyOriginFromWorkHistory', () => {
  it('exports the sentinel constants', () => {
    expect(PAO_AMPHOE_ID).toBe('3001');
    expect(PAO_LAO_ID).toBe('3001027');
  });

  it('returns agency-normal when WH.amphoe=3001 AND LAO=3001027', () => {
    const wh = {
      amphoe: { id: '3001' },
      localAdministrativeOrganization: { id: '3001027' },
    };
    expect(classifyOriginFromWorkHistory(wh)).toBe('agency-normal');
  });

  it('returns lao-coordinated when amphoe differs', () => {
    const wh = {
      amphoe: { id: '3009' },
      localAdministrativeOrganization: { id: '3001027' },
    };
    expect(classifyOriginFromWorkHistory(wh)).toBe('lao-coordinated');
  });

  it('returns lao-coordinated when LAO differs', () => {
    const wh = {
      amphoe: { id: '3001' },
      localAdministrativeOrganization: { id: '3001015' },
    };
    expect(classifyOriginFromWorkHistory(wh)).toBe('lao-coordinated');
  });

  it('returns lao-coordinated for null WH (defensive default)', () => {
    expect(classifyOriginFromWorkHistory(null)).toBe('lao-coordinated');
    expect(classifyOriginFromWorkHistory(undefined)).toBe('lao-coordinated');
  });

  it('returns lao-coordinated when amphoe / LAO relations are missing', () => {
    expect(
      classifyOriginFromWorkHistory({
        amphoe: null,
        localAdministrativeOrganization: null,
      }),
    ).toBe('lao-coordinated');
    expect(classifyOriginFromWorkHistory({ amphoe: { id: '3001' } })).toBe(
      'lao-coordinated',
    );
  });

  it('coerces numeric ids consistently', () => {
    // Some entity rows surface IDs as numeric — the helper MUST coerce
    // both sides to string before comparing.
    expect(
      classifyOriginFromWorkHistory({
        amphoe: { id: 3001 as unknown as string },
        localAdministrativeOrganization: { id: 3001027 as unknown as string },
      }),
    ).toBe('agency-normal');
  });
});

describe('W57-BE-AGG-02 / classifyOriginFromIdScalars (SQL-projection variant)', () => {
  it('mirrors the WH variant for matching scalars', () => {
    expect(classifyOriginFromIdScalars('3001', '3001027')).toBe(
      'agency-normal',
    );
    expect(classifyOriginFromIdScalars('3001', '3001015')).toBe(
      'lao-coordinated',
    );
    expect(classifyOriginFromIdScalars(null, null)).toBe('lao-coordinated');
  });

  it('treats numeric and string ids identically', () => {
    expect(classifyOriginFromIdScalars(3001, 3001027)).toBe('agency-normal');
  });
});

describe('W57-BE-AGG-02 / §5 immutability', () => {
  // The aggregator reads `creator.workHistory.amphoe` (via JOIN) — the
  // WH that was attached at row insertion time. Per §5 even if the
  // user's CURRENT WH later changes, the project's `originType` must
  // not. This test locks the contract by passing two different "WH"
  // shapes that conceptually represent (a) creator-WH-at-insert and
  // (b) caller-current-WH, and asserts the helper only ever uses the
  // WH it was given. Re-classification based on a different WH is the
  // caller's responsibility — and a bug if it happens.
  it('always classifies from the WH it was given (no hidden state)', () => {
    const creatorWh = {
      amphoe: { id: '3001' },
      localAdministrativeOrganization: { id: '3001027' },
    };
    const callerCurrentWh = {
      amphoe: { id: '3009' },
      localAdministrativeOrganization: { id: '3009999' },
    };
    expect(classifyOriginFromWorkHistory(creatorWh)).toBe('agency-normal');
    expect(classifyOriginFromWorkHistory(callerCurrentWh)).toBe(
      'lao-coordinated',
    );
    // Repeated invocation yields the same answer (no memoized state
    // that could leak across rows).
    expect(classifyOriginFromWorkHistory(creatorWh)).toBe('agency-normal');
  });
});
