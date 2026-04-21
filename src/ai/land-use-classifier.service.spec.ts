/**
 * Wave 32 N1 — LandUseClassifierService unit spec.
 *
 * Covers:
 *   1.  Cache hit short-circuits OpenAI call
 *   2.  Cache miss (different tambon) triggers new OpenAI call
 *   3.  Cache TTL expiry (24h) triggers refresh
 *   4.  Null / failure caching uses short TTL (1h)
 *   5.  Schema drift: invalid `primaryUse` → null
 *   6.  Schema drift: missing `rationale` → null
 *   7.  Malformed JSON → null
 *   8.  OpenAI network error → null (no throw)
 *   9.  Sanitizer strips `[GEO_GROUND_TRUTH]` markers from rationale
 *  10.  Anti-bias clause verbatim present in SYSTEM prompt
 *  11.  Structured-only input — USER prompt never contains user prose
 *  12.  FIFO cache cap — 1001st insert evicts oldest entry
 */
import { LandUseClassifierService, ClassifyInput } from './land-use-classifier.service';

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

function buildInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    lat: 14.9798,
    lng: 102.0978,
    adminBoundary: {
      tambonCode: '300102',
      tambonName: 'โคกกรวด',
      amphoeCode: '3001',
      amphoeName: 'เมืองนครราชสีมา',
      changwatCode: '30',
      changwatName: 'นครราชสีมา',
    },
    geoFeature: null,
    ...overrides,
  };
}

function validPayload(): string {
  return JSON.stringify({
    primaryUse: 'peri-urban',
    secondaryUse: 'พื้นที่ชุมชนรอบเมือง',
    confidence: 'medium',
    rationale: 'ตำบลโคกกรวดเป็นพื้นที่รอยต่อระหว่างเมืองและชนบท',
    landmarks: ['ตลาดโคกกรวด'],
  });
}

function mockOnce(content: string) {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  });
}

describe('LandUseClassifierService', () => {
  let service: LandUseClassifierService;

  beforeEach(() => {
    mockCreate.mockReset();
    // Wave 36 N2 — pass a no-op AiUsageLogsService mock so the
    // constructor's new injection (detail-log write) is satisfied.
    // `create` returns any value — behavior is fire-and-forget.
    service = new LandUseClassifierService({
      create: jest.fn().mockResolvedValue({}),
    } as any);
  });

  // -------------------------------------------------------------------
  // 1. Cache hit
  // -------------------------------------------------------------------
  it('returns cached result on second call with same tambon key (no new OpenAI call)', async () => {
    mockOnce(validPayload());
    const input = buildInput();

    const first = await service.classify(input);
    const second = await service.classify(input);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).toEqual(first);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------
  // 2. Cache miss on different tambon
  // -------------------------------------------------------------------
  it('triggers a new OpenAI call when a different tambon is classified', async () => {
    mockOnce(validPayload());
    mockOnce(validPayload());

    await service.classify(buildInput());
    await service.classify(
      buildInput({
        adminBoundary: {
          tambonCode: '300103',
          tambonName: 'จอหอ',
          amphoeCode: '3001',
          amphoeName: 'เมืองนครราชสีมา',
          changwatCode: '30',
          changwatName: 'นครราชสีมา',
        },
      }),
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------
  // 3. TTL expiry triggers fresh call
  // -------------------------------------------------------------------
  it('triggers a fresh OpenAI call after the 24h success TTL expires', async () => {
    const realNow = Date.now;
    const t0 = 1_700_000_000_000;
    let fake = t0;
    jest.spyOn(Date, 'now').mockImplementation(() => fake);

    try {
      mockOnce(validPayload());
      await service.classify(buildInput());
      expect(mockCreate).toHaveBeenCalledTimes(1);

      // Advance past 24h.
      fake = t0 + 25 * 60 * 60 * 1000;
      mockOnce(validPayload());
      await service.classify(buildInput());
      expect(mockCreate).toHaveBeenCalledTimes(2);
    } finally {
      (Date.now as unknown as jest.SpyInstance).mockRestore?.();
      Date.now = realNow;
    }
  });

  // -------------------------------------------------------------------
  // 4. Null caching uses shorter TTL
  // -------------------------------------------------------------------
  it('caches null with the shorter failure TTL so transient failures retry within 24h', async () => {
    const realNow = Date.now;
    const t0 = 1_700_000_000_000;
    let fake = t0;
    jest.spyOn(Date, 'now').mockImplementation(() => fake);

    try {
      mockCreate.mockRejectedValueOnce(new Error('network down'));
      const first = await service.classify(buildInput());
      expect(first).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);

      // 30 minutes later — still within failure TTL, cache hit.
      fake = t0 + 30 * 60 * 1000;
      const cached = await service.classify(buildInput());
      expect(cached).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);

      // 2 hours later — past failure TTL (1h), retry.
      fake = t0 + 2 * 60 * 60 * 1000;
      mockOnce(validPayload());
      const retried = await service.classify(buildInput());
      expect(retried).not.toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(2);
    } finally {
      (Date.now as unknown as jest.SpyInstance).mockRestore?.();
      Date.now = realNow;
    }
  });

  // -------------------------------------------------------------------
  // 5. Invalid primaryUse → null
  // -------------------------------------------------------------------
  it('returns null when LLM emits a primaryUse value outside the allowed enum', async () => {
    mockOnce(
      JSON.stringify({
        primaryUse: 'megacity',
        confidence: 'high',
        rationale: 'ทดสอบค่า primaryUse ที่ไม่ถูกต้อง',
      }),
    );
    const result = await service.classify(buildInput());
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------
  // 6. Missing rationale → null
  // -------------------------------------------------------------------
  it('returns null when rationale field is missing', async () => {
    mockOnce(
      JSON.stringify({
        primaryUse: 'agricultural',
        confidence: 'medium',
      }),
    );
    const result = await service.classify(buildInput());
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------
  // 7. Malformed JSON → null
  // -------------------------------------------------------------------
  it('returns null when LLM returns malformed JSON', async () => {
    mockOnce('not valid json {');
    const result = await service.classify(buildInput());
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------
  // 8. OpenAI throw → null
  // -------------------------------------------------------------------
  it('returns null and does not throw when OpenAI call rejects', async () => {
    mockCreate.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(service.classify(buildInput())).resolves.toBeNull();
  });

  // -------------------------------------------------------------------
  // 9. Sanitizer applied to rationale
  // -------------------------------------------------------------------
  it('strips bracketed prompt markers from the rationale via sanitizeBriefingText', async () => {
    mockOnce(
      JSON.stringify({
        primaryUse: 'agricultural',
        confidence: 'high',
        rationale:
          '[GEO_GROUND_TRUTH] พื้นที่นี้เป็นพื้นที่เกษตรกรรมตามข้อมูลสำรวจ',
      }),
    );
    const result = await service.classify(buildInput());
    expect(result).not.toBeNull();
    expect(result!.rationale).not.toContain('[GEO_GROUND_TRUTH]');
    expect(result!.rationale).toContain('พื้นที่เกษตรกรรม');
  });

  // -------------------------------------------------------------------
  // 10. Anti-bias clause present in SYSTEM prompt
  // -------------------------------------------------------------------
  it('includes the anti-bias clause verbatim in the system prompt', async () => {
    mockOnce(validPayload());
    await service.classify(buildInput());

    const call = mockCreate.mock.calls[0][0];
    const systemMsg = call.messages.find(
      (m: { role: string }) => m.role === 'system',
    );
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain('ห้ามจับคู่ผลการจำแนก');
    expect(systemMsg.content).toContain('classify honestly');
  });

  // -------------------------------------------------------------------
  // 10b. Wave 33.7 N2 — hydrology-priority clause in SYSTEM prompt
  // -------------------------------------------------------------------
  it('includes the Wave 33.7 hydrology-priority clause verbatim in the system prompt', async () => {
    mockOnce(validPayload());
    await service.classify(buildInput());

    const call = mockCreate.mock.calls[0][0];
    const systemMsg = call.messages.find(
      (m: { role: string }) => m.role === 'system',
    );
    expect(systemMsg).toBeDefined();
    // New clause tokens (grep-friendly).
    expect(systemMsg.content).toContain('เน้นลักษณะพิกัดจริง');
    expect(systemMsg.content).toContain('ลำดับความสำคัญพิกัดจริง');
    // Regression guard — prior anti-bias clause must still be present.
    expect(systemMsg.content).toContain('ห้ามจับคู่ผลการจำแนก');
  });

  // -------------------------------------------------------------------
  // 11. USER prompt does not contain user prose
  // -------------------------------------------------------------------
  it('never interpolates arbitrary user prose into the USER prompt (structured-only)', async () => {
    mockOnce(validPayload());
    await service.classify(
      buildInput({
        subTypeCode: '4.1',
        geoFeature: { featureType: 'reservoir', nameTh: 'อ่างเก็บน้ำลำตะคอง' },
      }),
    );

    const call = mockCreate.mock.calls[0][0];
    const userMsg = call.messages.find(
      (m: { role: string }) => m.role === 'user',
    );
    expect(userMsg).toBeDefined();
    // The prompt must be built from the structured fields only.
    const content = userMsg.content as string;
    expect(content).toContain('โคกกรวด');
    expect(content).toContain('sub-type 4.1');
    expect(content).toContain('อ่างเก็บน้ำลำตะคอง');
    // No leakage of hypothetical user-controlled fields like
    // additionalContext, title, description, userPrompt.
    expect(content).not.toMatch(/additionalContext/i);
    expect(content).not.toMatch(/userPrompt/i);
    expect(content).not.toMatch(/<<<USER_INPUT>>>/);
  });

  // Extra: model + temperature + response_format acceptance.
  it('invokes OpenAI with model gpt-4o-mini, temperature 0.15, and JSON response_format', async () => {
    mockOnce(validPayload());
    await service.classify(buildInput());
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o-mini');
    expect(call.temperature).toBe(0.15);
    expect(call.response_format).toEqual({ type: 'json_object' });
  });

  // -------------------------------------------------------------------
  // Wave 35 N1 — peekCache contract
  // -------------------------------------------------------------------
  describe('peekCache (Wave 35 N1)', () => {
    it('returns null on cache miss without invoking OpenAI', () => {
      const result = service.peekCache('3001', '300102');
      expect(result).toBeNull();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('returns the cached classification on hit without a fresh OpenAI call', async () => {
      mockOnce(validPayload());
      const classified = await service.classify(buildInput());
      expect(classified).not.toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);

      // peek should NOT fire a second OpenAI call.
      const peeked = service.peekCache('3001', '300102');
      expect(peeked).toEqual(classified);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('returns null for an expired cache entry without firing a fresh call', async () => {
      const realNow = Date.now;
      const t0 = 1_700_000_000_000;
      let fake = t0;
      jest.spyOn(Date, 'now').mockImplementation(() => fake);

      try {
        mockOnce(validPayload());
        await service.classify(buildInput());
        expect(mockCreate).toHaveBeenCalledTimes(1);

        // Jump past the 24h success TTL.
        fake = t0 + 25 * 60 * 60 * 1000;
        const peeked = service.peekCache('3001', '300102');
        expect(peeked).toBeNull();
        // peek must NEVER trigger a fresh OpenAI call.
        expect(mockCreate).toHaveBeenCalledTimes(1);
      } finally {
        (Date.now as unknown as jest.SpyInstance).mockRestore?.();
        Date.now = realNow;
      }
    });

    it('returns null when the cached value is a failure placeholder (null)', async () => {
      mockCreate.mockRejectedValueOnce(new Error('network down'));
      const classified = await service.classify(buildInput());
      expect(classified).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);

      // Cache now holds a null placeholder. peek returns null AND
      // MUST NOT fire a retry — `classify()` owns the retry schedule.
      const peeked = service.peekCache('3001', '300102');
      expect(peeked).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('returns null when amphoeCode or tambonCode is missing', () => {
      expect(service.peekCache(null, '300102')).toBeNull();
      expect(service.peekCache('3001', null)).toBeNull();
      expect(service.peekCache(undefined, undefined)).toBeNull();
      expect(service.peekCache('', '')).toBeNull();
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // 12. FIFO cache cap — 1001st insert evicts oldest
  // -------------------------------------------------------------------
  it('evicts the oldest entry when the 1001st key is inserted', async () => {
    // Respond successfully for every call.
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: validPayload() } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });

    const firstKey = 'A0000:T0000';
    // Insert 1001 distinct tambon keys.
    for (let i = 0; i < 1001; i++) {
      const amp = `A${String(i).padStart(4, '0')}`;
      const tam = `T${String(i).padStart(4, '0')}`;
      await service.classify(
        buildInput({
          adminBoundary: {
            tambonCode: tam,
            tambonName: `tam-${i}`,
            amphoeCode: amp,
            amphoeName: `amp-${i}`,
            changwatCode: '30',
            changwatName: 'นครราชสีมา',
          },
        }),
      );
    }

    expect(service._cacheSizeForTest()).toBe(1000);
    expect(service._cacheHasForTest(firstKey)).toBe(false);
  });
});
