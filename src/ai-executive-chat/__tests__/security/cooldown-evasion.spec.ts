/**
 * SEC-W44-01 — Attack class #10: cooldown evasion.
 *
 * Threat model:
 *  - Adversary submits two chat requests in rapid succession against
 *    the same conversation to amplify bandwidth / token burn.
 *  - Adversary omits `conversationId` expecting the cooldown key to
 *    collapse to a no-op.
 *  - OpenAI returns 5xx and the adversary retries immediately,
 *    expecting the cooldown to already be armed.
 *
 * Defense (§17.8):
 *  - Cooldown key = `(endpointKey|actorId|targetId?? '__no_target__')`.
 *    Omitting the conversationId collapses to a SHARED key per
 *    (endpoint, actor) — still cooldown-gated, cannot evade.
 *  - 2nd request within the TTL window → 429 AI_COOLDOWN_ACTIVE with
 *    `Retry-After` header.
 *  - ONLY 2xx responses arm the cooldown. 4xx / 5xx MUST NOT arm
 *    (prevents locking out a user after a provider outage).
 *
 * This spec tests `AiCooldownGuard` + `InMemoryAiCooldownStore`
 * directly. Both are landed code paths.
 */

import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AiCooldownGuard,
  buildCooldownKey,
} from 'src/ai/guards/ai-cooldown.guard';
import {
  AI_COOLDOWN_METADATA,
  AiCooldownMetadata,
} from 'src/ai/decorators/ai-cooldown.decorator';
import { InMemoryAiCooldownStore } from 'src/ai/stores/ai-cooldown.store';

const META: AiCooldownMetadata = {
  endpointKey: 'executive-chat',
  ttlSeconds: 6,
  keyFrom: 'body.conversationId',
};

type FinishHandler = () => void;

function mkResponse() {
  const listeners: FinishHandler[] = [];
  const res = {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this._headers[k] = v;
    },
    on(event: string, cb: FinishHandler) {
      if (event === 'finish') listeners.push(cb);
    },
    emitFinish() {
      listeners.forEach((l) => l());
    },
  };
  return res;
}

function mkCtx(user: { userId?: string }, body: Record<string, unknown>) {
  const response = mkResponse();
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ user, body }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { ctx, response };
}

function mkReflectorWithMeta(meta: AiCooldownMetadata | undefined) {
  const r = new Reflector();
  // Patch getAllAndOverride to return our fixed metadata regardless of
  // the handler passed in (simplifies test wiring).
  (r as unknown as { getAllAndOverride: jest.Mock }).getAllAndOverride = jest
    .fn()
    .mockReturnValue(meta);
  return r;
}

describe('SEC-W44-01 / cooldown-evasion (§17.8)', () => {
  let store: InMemoryAiCooldownStore;
  let guard: AiCooldownGuard;

  beforeEach(() => {
    store = new InMemoryAiCooldownStore();
    guard = new AiCooldownGuard(mkReflectorWithMeta(META), store);
  });

  it('1st request passes; 2nd request same (actor, conversationId) within TTL → 429 with Retry-After', async () => {
    const { ctx: ctx1, response: res1 } = mkCtx(
      { userId: 'exec-1' },
      { conversationId: 'conv-1' },
    );
    await expect(guard.canActivate(ctx1)).resolves.toBe(true);

    // Simulate a 2xx finish arming the cooldown.
    (res1 as unknown as { statusCode: number }).statusCode = 200;
    res1.emitFinish();

    const { ctx: ctx2, response: res2 } = mkCtx(
      { userId: 'exec-1' },
      { conversationId: 'conv-1' },
    );
    await expect(guard.canActivate(ctx2)).rejects.toBeInstanceOf(HttpException);
    try {
      await guard.canActivate(ctx2);
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect((e as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'AI_COOLDOWN_ACTIVE' }),
      );
    }
    expect(res2._headers['Retry-After']).toMatch(/^\d+$/);
  });

  it('omitting conversationId collapses to `__no_target__` shared key (same user cannot evade)', async () => {
    // Build the key the guard would build for a missing target.
    const sharedKey = buildCooldownKey(
      'executive-chat',
      'exec-1',
      '__no_target__',
    );
    expect(sharedKey).toBe('executive-chat|exec-1|__no_target__');

    const { ctx: ctx1, response: res1 } = mkCtx({ userId: 'exec-1' }, {});
    await expect(guard.canActivate(ctx1)).resolves.toBe(true);
    (res1 as unknown as { statusCode: number }).statusCode = 200;
    res1.emitFinish();

    const { ctx: ctx2 } = mkCtx({ userId: 'exec-1' }, {});
    await expect(guard.canActivate(ctx2)).rejects.toThrow(HttpException);
  });

  it('different users do NOT share the cooldown', async () => {
    const { ctx: ctx1, response: res1 } = mkCtx(
      { userId: 'exec-1' },
      { conversationId: 'conv-1' },
    );
    await guard.canActivate(ctx1);
    (res1 as unknown as { statusCode: number }).statusCode = 200;
    res1.emitFinish();

    const { ctx: ctx2 } = mkCtx(
      { userId: 'exec-2' },
      { conversationId: 'conv-1' },
    );
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);
  });

  it('5xx response does NOT arm cooldown (user can retry immediately after provider outage)', async () => {
    const { ctx: ctx1, response: res1 } = mkCtx(
      { userId: 'exec-1' },
      { conversationId: 'conv-1' },
    );
    await guard.canActivate(ctx1);
    (res1 as unknown as { statusCode: number }).statusCode = 500;
    res1.emitFinish();

    // No cooldown was armed — second request passes.
    const { ctx: ctx2 } = mkCtx(
      { userId: 'exec-1' },
      { conversationId: 'conv-1' },
    );
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);
  });

  it('4xx response does NOT arm cooldown (e.g. 429 AI_QUOTA_EXHAUSTED from the upstream guard)', async () => {
    const { ctx: ctx1, response: res1 } = mkCtx(
      { userId: 'exec-1' },
      { conversationId: 'conv-1' },
    );
    await guard.canActivate(ctx1);
    (res1 as unknown as { statusCode: number }).statusCode = 429;
    res1.emitFinish();

    const { ctx: ctx2 } = mkCtx(
      { userId: 'exec-1' },
      { conversationId: 'conv-1' },
    );
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);
  });

  it('cooldown store key shape: `executive-chat|<actorId>|<conversationId>`', () => {
    expect(buildCooldownKey('executive-chat', 'exec-1', 'conv-1')).toBe(
      'executive-chat|exec-1|conv-1',
    );
  });

  it('cooldown entry is cleared after TTL elapses (store semantics)', async () => {
    const key = buildCooldownKey('executive-chat', 'exec-1', 'conv-1');
    await store.set(key, Date.now() + 50);
    expect(await store.get(key)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(await store.get(key)).toBeNull();
  });

  /**
   * DEFENSE NOTE:
   *  - The shared `__no_target__` key means that a user CAN evade the
   *    per-conversation cooldown by alternating with a conversationId:
   *    a request with `conversationId=X` and a request with no
   *    conversationId have DIFFERENT keys and neither blocks the other
   *    on the first call. For the executive-chat endpoint this is
   *    acceptable because POST /messages is also gated by the per-user
   *    AiQuotaGuard (BE-W44-03) which cannot be bypassed by key
   *    manipulation.
   *  - A stricter cooldown (actor-only, ignore conversation) would
   *    reduce UX quality (multiple parallel conversations). If a future
   *    wave wants stricter per-user gating, consider adding a second
   *    @AiCooldown layer with keyFrom='userId' and a longer TTL.
   */
});
