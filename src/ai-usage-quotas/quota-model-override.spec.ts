import { resolveModel } from './quota-model-override';

/**
 * Wave 44 / BE-W44-03 — auto-downgrade boundary tests (task §7.10 /
 * §13 acceptance-criterion "Auto-downgrade").
 */
describe('resolveModel', () => {
  it('honors declared model below 80 % consumed', () => {
    expect(resolveModel(0.0, 'gpt-4o')).toBe('gpt-4o');
    expect(resolveModel(0.5, 'gpt-4o')).toBe('gpt-4o');
    expect(resolveModel(0.79, 'gpt-4o')).toBe('gpt-4o');
  });

  it('downgrades to gpt-4o-mini at exactly 80 % consumed', () => {
    expect(resolveModel(0.8, 'gpt-4o')).toBe('gpt-4o-mini');
  });

  it('downgrades to gpt-4o-mini above 80 % consumed', () => {
    expect(resolveModel(0.85, 'gpt-4o')).toBe('gpt-4o-mini');
    expect(resolveModel(0.99, 'gpt-4o')).toBe('gpt-4o-mini');
  });

  it('keeps gpt-4o-mini as-is when already declared', () => {
    expect(resolveModel(0.0, 'gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(resolveModel(0.85, 'gpt-4o-mini')).toBe('gpt-4o-mini');
  });

  it('falls back to declared model on non-finite ratio', () => {
    expect(resolveModel(NaN, 'gpt-4o')).toBe('gpt-4o');
    expect(resolveModel(Infinity, 'gpt-4o')).toBe('gpt-4o');
  });
});
