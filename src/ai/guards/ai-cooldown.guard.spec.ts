import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitter } from 'events';
import { AiCooldownGuard, buildCooldownKey } from './ai-cooldown.guard';
import {
  AI_COOLDOWN_METADATA,
  AiCooldownMetadata,
} from '../decorators/ai-cooldown.decorator';
import { InMemoryAiCooldownStore } from '../stores/ai-cooldown.store';

/**
 * Unit tests for AiCooldownGuard — per CLAUDE.md §17.8.
 *
 * Critical guarantees verified:
 *   - First call passes.
 *   - Second call within TTL returns 429 with structured body + Retry-After.
 *   - Calls AFTER ttl expires pass.
 *   - 5xx (and 4xx) responses MUST NOT arm the cooldown.
 *   - Distinct (actor, target) keys do not collide.
 */

type MockResponse = EventEmitter & {
  statusCode: number;
  setHeader: jest.Mock;
  _finish: (status: number) => void;
};

function makeResponse(): MockResponse {
  const emitter = new EventEmitter() as MockResponse;
  emitter.statusCode = 200;
  emitter.setHeader = jest.fn();
  emitter._finish = (status: number) => {
    emitter.statusCode = status;
    emitter.emit('finish');
  };
  return emitter;
}

function makeContext(opts: {
  user?: { userId?: string };
  body?: Record<string, unknown>;
  metadata?: AiCooldownMetadata;
  response?: MockResponse;
}): ExecutionContext {
  const req = {
    user: opts.user ?? { userId: 'user-1' },
    body: opts.body ?? { projectId: 'proj-1' },
  };
  const res = opts.response ?? makeResponse();
  return {
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => jest.fn(),
    }),
  } as unknown as ExecutionContext;
}

function makeReflector(metadata: AiCooldownMetadata | null): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(metadata),
  } as unknown as Reflector;
}

describe('AiCooldownGuard', () => {
  const meta: AiCooldownMetadata = {
    endpointKey: 'smart-approve',
    ttlSeconds: 10,
    keyFrom: 'body.projectId',
  };

  let store: InMemoryAiCooldownStore;
  let guard: AiCooldownGuard;

  beforeEach(() => {
    store = new InMemoryAiCooldownStore();
    guard = new AiCooldownGuard(makeReflector(meta), store);
  });

  it('first call passes without arming if response is not yet finished', async () => {
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('second call within window returns 429 with structured body + Retry-After', async () => {
    const res = makeResponse();
    const ctx1 = makeContext({ response: res });
    await guard.canActivate(ctx1);
    res._finish(200); // arm cooldown

    const res2 = makeResponse();
    const ctx2 = makeContext({ response: res2 });
    let caught: HttpException | null = null;
    try {
      await guard.canActivate(ctx2);
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(429);
    const body = caught!.getResponse() as {
      code: string;
      remainingSeconds: number;
      message: string;
    };
    expect(body.code).toBe('AI_COOLDOWN_ACTIVE');
    expect(typeof body.remainingSeconds).toBe('number');
    expect(body.remainingSeconds).toBeGreaterThan(0);
    expect(body.remainingSeconds).toBeLessThanOrEqual(10);
    expect(typeof body.message).toBe('string');
    expect(res2.setHeader).toHaveBeenCalledWith(
      'Retry-After',
      String(body.remainingSeconds),
    );
  });

  it('call AFTER ttl expires passes again', async () => {
    const shortMeta: AiCooldownMetadata = {
      ...meta,
      ttlSeconds: 1,
    };
    const localGuard = new AiCooldownGuard(makeReflector(shortMeta), store);
    const res1 = makeResponse();
    const ctx1 = makeContext({ response: res1 });
    await localGuard.canActivate(ctx1);
    res1._finish(200);

    // Advance clock past TTL.
    const realNow = Date.now;
    const future = realNow() + 5_000;
    jest.spyOn(Date, 'now').mockImplementation(() => future);

    const ctx2 = makeContext({});
    await expect(localGuard.canActivate(ctx2)).resolves.toBe(true);

    jest.spyOn(Date, 'now').mockRestore();
  });

  it('5xx response MUST NOT arm cooldown (CLAUDE.md §17.8)', async () => {
    const res = makeResponse();
    const ctx1 = makeContext({ response: res });
    await guard.canActivate(ctx1);
    res._finish(500); // LLM upstream failure

    // Immediate retry — cooldown must NOT be armed.
    const ctx2 = makeContext({});
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);

    // Verify store is empty for the key.
    const key = buildCooldownKey('smart-approve', 'user-1', 'proj-1');
    await expect(store.get(key)).resolves.toBeNull();
  });

  it('4xx response does NOT arm cooldown', async () => {
    const res = makeResponse();
    const ctx1 = makeContext({ response: res });
    await guard.canActivate(ctx1);
    res._finish(400);

    const ctx2 = makeContext({});
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);
  });

  it('different (actor, target) keys do not collide', async () => {
    const resA = makeResponse();
    await guard.canActivate(
      makeContext({
        user: { userId: 'user-A' },
        body: { projectId: 'proj-1' },
        response: resA,
      }),
    );
    resA._finish(200);

    // Different user, same target — should pass.
    await expect(
      guard.canActivate(
        makeContext({
          user: { userId: 'user-B' },
          body: { projectId: 'proj-1' },
        }),
      ),
    ).resolves.toBe(true);

    // Same user, different target — should pass.
    await expect(
      guard.canActivate(
        makeContext({
          user: { userId: 'user-A' },
          body: { projectId: 'proj-2' },
        }),
      ),
    ).resolves.toBe(true);

    // Same user, same target — should throw 429.
    let threw = false;
    try {
      await guard.canActivate(
        makeContext({
          user: { userId: 'user-A' },
          body: { projectId: 'proj-1' },
        }),
      );
    } catch (err) {
      threw = (err as HttpException).getStatus() === 429;
    }
    expect(threw).toBe(true);
  });

  it('passes through when no @AiCooldown metadata is present', async () => {
    const bare = new AiCooldownGuard(makeReflector(null), store);
    const ctx = makeContext({});
    await expect(bare.canActivate(ctx)).resolves.toBe(true);
  });

  it('missing target id still enforces a (actor × endpoint) window', async () => {
    const res = makeResponse();
    await guard.canActivate(
      makeContext({
        body: {}, // no projectId
        response: res,
      }),
    );
    res._finish(200);

    let threw = false;
    try {
      await guard.canActivate(makeContext({ body: {} }));
    } catch (err) {
      threw = (err as HttpException).getStatus() === 429;
    }
    expect(threw).toBe(true);
  });
});

describe('InMemoryAiCooldownStore LRU bound', () => {
  it('evicts oldest entries past capacity', async () => {
    const store = new InMemoryAiCooldownStore();
    const cap = InMemoryAiCooldownStore.MEMORY_CAPACITY;
    const far = Date.now() + 60_000;
    for (let i = 0; i < cap + 50; i++) {
      await store.set(`k-${i}`, far);
    }
    expect(store._size()).toBeLessThanOrEqual(cap);
    // The first few keys must be gone.
    await expect(store.get('k-0')).resolves.toBeNull();
  });
});
