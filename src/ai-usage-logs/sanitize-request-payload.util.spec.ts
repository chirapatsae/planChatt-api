import { sanitizeRequestPayload } from './sanitize-request-payload.util';

describe('sanitizeRequestPayload (Wave 36 N2 · §17.9)', () => {
  it('strips userPrompt and emits userPromptLength', () => {
    const out = sanitizeRequestPayload({ userPrompt: 'secret' });
    expect(out).not.toHaveProperty('userPrompt');
    expect(out).toEqual({ userPromptLength: 6 });
  });

  it('strips additionalContext and emits length', () => {
    const out = sanitizeRequestPayload({ additionalContext: 'hello world' });
    expect(out).not.toHaveProperty('additionalContext');
    expect(out.additionalContextLength).toBe(11);
  });

  it('strips justification and emits length', () => {
    const out = sanitizeRequestPayload({ justification: 'x'.repeat(100) });
    expect(out).not.toHaveProperty('justification');
    expect(out.justificationLength).toBe(100);
  });

  it('strips description and emits length', () => {
    const out = sanitizeRequestPayload({ description: 'abc' });
    expect(out).not.toHaveProperty('description');
    expect(out.descriptionLength).toBe(3);
  });

  it('strips objective, rawText, and ocrText', () => {
    const out = sanitizeRequestPayload({
      objective: 'obj',
      rawText: 'raw',
      ocrText: 'ocr',
    });
    expect(out).not.toHaveProperty('objective');
    expect(out).not.toHaveProperty('rawText');
    expect(out).not.toHaveProperty('ocrText');
    expect(out.objectiveLength).toBe(3);
    expect(out.rawTextLength).toBe(3);
    expect(out.ocrTextLength).toBe(3);
  });

  it('recursively sanitizes nested objects', () => {
    const out = sanitizeRequestPayload({
      outer: { inner: { userPrompt: 'deep secret' } },
    });
    expect(out.outer.inner).not.toHaveProperty('userPrompt');
    expect(out.outer.inner.userPromptLength).toBe(11);
  });

  it('recursively sanitizes arrays of objects', () => {
    const out = sanitizeRequestPayload([
      { userPrompt: 'a' },
      { userPrompt: 'bb' },
    ]);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).not.toHaveProperty('userPrompt');
    expect(out[0].userPromptLength).toBe(1);
    expect(out[1].userPromptLength).toBe(2);
  });

  it('leaves clean payloads unchanged', () => {
    const clean = {
      reportFormat: 'ISSUE_BASED',
      subTypeCode: '4.1',
      startLat: '14.9',
      startLng: '102.1',
    };
    expect(sanitizeRequestPayload(clean)).toEqual(clean);
  });

  it('handles null / undefined / primitives gracefully', () => {
    expect(sanitizeRequestPayload(null)).toBeNull();
    expect(sanitizeRequestPayload(undefined)).toBeNull();
    expect(sanitizeRequestPayload('str')).toBe('str');
    expect(sanitizeRequestPayload(42)).toBe(42);
    expect(sanitizeRequestPayload(true)).toBe(true);
  });
});
