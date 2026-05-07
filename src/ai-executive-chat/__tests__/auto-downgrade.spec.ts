/**
 * BE-W44-02 — auto-downgrade at 80% quota consumption (§17.8 / §17.11).
 *
 * The model-override rule lives in `resolveModel` and is invoked by
 * both `AiQuotaGuard.canActivate` (pre-call) AND `AiQuotaGuard.checkMidTurn`
 * (per-hop). A turn that begins on the declared model must automatically
 * flip to the cheap-fallback model once cumulative spend crosses 80% so
 * that long tool-loop turns do not exhaust the quota.
 *
 * W68-FIX-08 (2026-04-28) — fallback target switched from
 * `'gpt-4o-mini'` → `'gpt-4.1-nano'` (4× cheaper, 400k TPM). The
 * declared model for executive-chat also switched from `'gpt-4o'` →
 * `'gpt-4.1-mini'` in the weight map; under-80%-consumed cases now
 * resolve to that. Below tests cover both paths: legacy `'gpt-4o'`
 * declarations still pass through the helper unchanged below the
 * threshold, and any declaration downgrades to `'gpt-4.1-nano'`
 * above it.
 */
import { resolveModel } from '../../ai-usage-quotas/quota-model-override';
import { AiQuotaGuard } from '../../ai-usage-quotas/guards/ai-quota.guard';

function quotaStub(quotaLimit: number, quotaUsed: number, remaining: number) {
  return {
    getQuotaSnapshot: jest.fn().mockResolvedValue({
      id: 'q1',
      quotaLimit,
      quotaUsed,
      remainingQuota: remaining,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 86_400_000),
      isAutoRenew: true,
    }),
  } as unknown as Parameters<typeof AiQuotaGuard.checkMidTurn>[0];
}

const orgStub = {
  checkOrgCap: jest
    .fn()
    .mockResolvedValue({ withinCap: true, usedThb: 1, capThb: 10_000 }),
} as unknown as Parameters<typeof AiQuotaGuard.checkMidTurn>[1];

describe('BE-W44-02 / auto-downgrade at 80% consumption (§17.8)', () => {
  it('resolveModel keeps the declared model below 80% consumed', () => {
    // W68-FIX-08: identity branch preserved across model families.
    expect(resolveModel(0.0, 'gpt-4o')).toBe('gpt-4o');
    expect(resolveModel(0.79, 'gpt-4o')).toBe('gpt-4o');
    expect(resolveModel(0.0, 'gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(resolveModel(0.79, 'gpt-4.1-mini')).toBe('gpt-4.1-mini');
  });

  it('resolveModel flips to gpt-4.1-nano at/above 80% consumed (W68-FIX-08)', () => {
    // W68-FIX-08: cheap fallback moved from 'gpt-4o-mini' → 'gpt-4.1-nano'
    // (4× cheaper, 400k TPM). The downgrade target is uniform regardless
    // of the declared model.
    expect(resolveModel(0.8, 'gpt-4o')).toBe('gpt-4.1-nano');
    expect(resolveModel(0.85, 'gpt-4.1-mini')).toBe('gpt-4.1-nano');
    expect(resolveModel(0.99, 'gpt-4o')).toBe('gpt-4.1-nano');
  });

  it('resolveModel leaves cheap-tier declarations effectively unchanged at threshold', () => {
    // Below threshold the declared cheap model passes through; above the
    // threshold the helper would flip to nano (which IS the cheap fallback).
    expect(resolveModel(0.5, 'gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(resolveModel(0.5, 'gpt-4.1-nano')).toBe('gpt-4.1-nano');
  });

  it('checkMidTurn emits modelOverride=gpt-4.1-nano when consumed ratio ≥ 0.80 (W68-FIX-08)', async () => {
    const quota = quotaStub(300, 270, 30); // 90% consumed
    const res = await AiQuotaGuard.checkMidTurn(
      quota,
      orgStub,
      'user-1',
      'executive-chat',
    );
    expect(res.ok).toBe(true);
    expect(res.modelOverride).toBe('gpt-4.1-nano');
  });

  it('checkMidTurn emits weight-map default model (gpt-4.1-mini) when consumed ratio below 0.80 (W68-FIX-08)', async () => {
    // W68-FIX-08 (2026-04-28) — switched executive-chat default from
    // 'gpt-4o' → 'gpt-4.1-mini'. The weight-map entry is the single
    // source of truth; under 80% consumption the resolved override is
    // therefore 'gpt-4.1-mini'. The §7.10 auto-downgrade rule continues
    // to perform a real flip — but the downgrade target is now
    // 'gpt-4.1-nano' (see the ≥0.80 test above).
    const quota = quotaStub(300, 100, 200); // 33% consumed
    const res = await AiQuotaGuard.checkMidTurn(
      quota,
      orgStub,
      'user-1',
      'executive-chat',
    );
    expect(res.ok).toBe(true);
    expect(res.modelOverride).toBe('gpt-4.1-mini');
  });

  it('mid-turn downgrade is idempotent — repeated calls over 80% keep nano (W68-FIX-08)', async () => {
    const quota = quotaStub(300, 250, 50); // 83%
    const a = await AiQuotaGuard.checkMidTurn(
      quota,
      orgStub,
      'user-1',
      'executive-chat',
    );
    const b = await AiQuotaGuard.checkMidTurn(
      quota,
      orgStub,
      'user-1',
      'executive-chat',
    );
    expect(a.modelOverride).toBe('gpt-4.1-nano');
    expect(b.modelOverride).toBe('gpt-4.1-nano');
  });
});
