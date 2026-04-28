import { getUsdToThbFx } from './fx-config';

/**
 * Wave 44 / BE-W44-03 — FX config tests (task §13 acceptance-criterion
 * "FX config").
 *
 * All cases mutate and restore `process.env.OPENAI_USD_TO_THB_FX`
 * inside the test so runs stay isolated.
 */
describe('getUsdToThbFx', () => {
  const ORIGINAL = process.env.OPENAI_USD_TO_THB_FX;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OPENAI_USD_TO_THB_FX;
    else process.env.OPENAI_USD_TO_THB_FX = ORIGINAL;
  });

  it('returns 34 when env is unset', () => {
    delete process.env.OPENAI_USD_TO_THB_FX;
    expect(getUsdToThbFx()).toBe(34);
  });

  it('returns parsed value when env is a valid positive number', () => {
    process.env.OPENAI_USD_TO_THB_FX = '36.5';
    expect(getUsdToThbFx()).toBe(36.5);
  });

  it('falls back to 34 on non-numeric env', () => {
    process.env.OPENAI_USD_TO_THB_FX = 'abc';
    expect(getUsdToThbFx()).toBe(34);
  });

  it('falls back to 34 on negative env', () => {
    process.env.OPENAI_USD_TO_THB_FX = '-1';
    expect(getUsdToThbFx()).toBe(34);
  });

  it('falls back to 34 on zero env', () => {
    process.env.OPENAI_USD_TO_THB_FX = '0';
    expect(getUsdToThbFx()).toBe(34);
  });
});
