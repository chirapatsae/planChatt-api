/**
 * BE-W44-02 — per-hop mid-turn quota enforcement (§17.8 / §17.11).
 *
 * The tool loop MUST call `AiQuotaGuard.checkMidTurn` BEFORE every
 * LLM hop. When the caller's remaining quota drops below a single-hop
 * threshold, the loop must emit `quota_soft_stop` and return partial
 * output — it must NEVER continue to spend on the next hop.
 *
 * This spec exercises the static `checkMidTurn` helper directly
 * using stubbed quota + orgCap services. The heavier DI-wired service
 * flow is covered at integration tier (deferred to W44 SEC/QA).
 */
import { AiQuotaGuard } from '../../ai-usage-quotas/guards/ai-quota.guard';
import { QUOTA_WEIGHT_MAP } from '../../ai-usage-quotas/quota-weight.map';

function makeQuotaStub(remaining: number, limit = 1000, used = 0) {
  return {
    getQuotaSnapshot: jest.fn().mockResolvedValue({
      id: 'q1',
      quotaLimit: limit,
      quotaUsed: used,
      remainingQuota: remaining,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 86_400_000),
      isAutoRenew: true,
    }),
  } as unknown as Parameters<typeof AiQuotaGuard.checkMidTurn>[0];
}

function makeOrgCapStub(withinCap: boolean) {
  return {
    checkOrgCap: jest.fn().mockResolvedValue({
      withinCap,
      usedThb: withinCap ? 10 : 99999,
      capThb: 10000,
    }),
  } as unknown as Parameters<typeof AiQuotaGuard.checkMidTurn>[1];
}

describe('BE-W44-02 / per-hop mid-turn quota (§17.8)', () => {
  it('returns ok=true when the caller has room for one more hop', async () => {
    const weight = QUOTA_WEIGHT_MAP['executive-chat'];
    expect(weight).toBeDefined();

    const quota = makeQuotaStub(weight.estMinThb * 2);
    const org = makeOrgCapStub(true);
    const res = await AiQuotaGuard.checkMidTurn(
      quota,
      org,
      'user-1',
      'executive-chat',
    );
    expect(res.ok).toBe(true);
    expect(res.remainingThb).toBeGreaterThan(0);
  });

  it('returns ok=false with USER_QUOTA_EXHAUSTED when remaining falls below single-hop threshold', async () => {
    const quota = makeQuotaStub(0.0001);
    const org = makeOrgCapStub(true);
    const res = await AiQuotaGuard.checkMidTurn(
      quota,
      org,
      'user-1',
      'executive-chat',
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('USER_QUOTA_EXHAUSTED');
  });

  it('returns ok=false with ORG_CAP_EXHAUSTED when the org is over cap', async () => {
    const weight = QUOTA_WEIGHT_MAP['executive-chat'];
    const quota = makeQuotaStub(weight.estMinThb * 10);
    const org = makeOrgCapStub(false);
    const res = await AiQuotaGuard.checkMidTurn(
      quota,
      org,
      'user-1',
      'executive-chat',
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ORG_CAP_EXHAUSTED');
  });

  it('never throws — callers must inspect `ok` (soft-stop contract)', async () => {
    const badQuota = {
      getQuotaSnapshot: jest.fn().mockResolvedValue(null),
    } as unknown as Parameters<typeof AiQuotaGuard.checkMidTurn>[0];
    const org = makeOrgCapStub(true);
    await expect(
      AiQuotaGuard.checkMidTurn(badQuota, org, 'user-1', 'executive-chat'),
    ).resolves.toBeDefined();
  });

  it('unknown weightKey fails closed (ok=false) to protect budget', async () => {
    const quota = makeQuotaStub(100);
    const org = makeOrgCapStub(true);
    const res = await AiQuotaGuard.checkMidTurn(
      quota,
      org,
      'user-1',
      'not-a-real-key',
    );
    expect(res.ok).toBe(false);
  });
});
