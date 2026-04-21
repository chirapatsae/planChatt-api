import {
  BUDGET_FLOOR_BY_LAO_TYPE,
  resolveBudgetFloor,
  parseBudgetString,
  clampBudget,
} from './budget-rules';

describe('Wave 34 N1 — budget-rules registry', () => {
  describe('BUDGET_FLOOR_BY_LAO_TYPE registry', () => {
    it('includes all 5 expected keys (4 LAO types + short form)', () => {
      expect(BUDGET_FLOOR_BY_LAO_TYPE['องค์การบริหารส่วนตำบล']).toBe(
        1_000_000,
      );
      expect(BUDGET_FLOOR_BY_LAO_TYPE['อบต.']).toBe(1_000_000);
      expect(BUDGET_FLOOR_BY_LAO_TYPE['เทศบาลตำบล']).toBe(1_000_000);
      expect(BUDGET_FLOOR_BY_LAO_TYPE['เทศบาลเมือง']).toBe(2_000_000);
      expect(BUDGET_FLOOR_BY_LAO_TYPE['เทศบาลนคร']).toBe(2_000_000);
    });

    it('is frozen (cannot be mutated)', () => {
      expect(Object.isFrozen(BUDGET_FLOOR_BY_LAO_TYPE)).toBe(true);
    });
  });

  describe('resolveBudgetFloor', () => {
    it('returns 1,000,000 for องค์การบริหารส่วนตำบล', () => {
      expect(resolveBudgetFloor('องค์การบริหารส่วนตำบล')).toBe(1_000_000);
    });

    it('returns 1,000,000 for อบต. short form', () => {
      expect(resolveBudgetFloor('อบต.')).toBe(1_000_000);
    });

    it('returns 1,000,000 for เทศบาลตำบล', () => {
      expect(resolveBudgetFloor('เทศบาลตำบล')).toBe(1_000_000);
    });

    it('returns 2,000,000 for เทศบาลเมือง', () => {
      expect(resolveBudgetFloor('เทศบาลเมือง')).toBe(2_000_000);
    });

    it('returns 2,000,000 for เทศบาลนคร', () => {
      expect(resolveBudgetFloor('เทศบาลนคร')).toBe(2_000_000);
    });

    it('returns null for อบจ. (not in registry — provincial)', () => {
      expect(resolveBudgetFloor('อบจ.')).toBeNull();
    });

    it('returns null for เมืองพัทยา (not in registry — special admin)', () => {
      expect(resolveBudgetFloor('เมืองพัทยา')).toBeNull();
    });

    it('returns null for null / undefined / empty / whitespace-only', () => {
      expect(resolveBudgetFloor(null)).toBeNull();
      expect(resolveBudgetFloor(undefined)).toBeNull();
      expect(resolveBudgetFloor('')).toBeNull();
      expect(resolveBudgetFloor('   ')).toBeNull();
    });

    it('trims whitespace before lookup', () => {
      expect(resolveBudgetFloor('  เทศบาลนคร  ')).toBe(2_000_000);
    });
  });

  describe('parseBudgetString', () => {
    it('parses "1500000" → 1_500_000', () => {
      expect(parseBudgetString('1500000')).toBe(1_500_000);
    });

    it('parses "1,500,000" → 1_500_000', () => {
      expect(parseBudgetString('1,500,000')).toBe(1_500_000);
    });

    it('parses "1,500,000 บาท" → 1_500_000', () => {
      expect(parseBudgetString('1,500,000 บาท')).toBe(1_500_000);
    });

    it('parses "1,500,000.00" → 1_500_000', () => {
      expect(parseBudgetString('1,500,000.00')).toBe(1_500_000);
    });

    it('parses "ประมาณ 1,500,000 บาท" → 1_500_000', () => {
      expect(parseBudgetString('ประมาณ 1,500,000 บาท')).toBe(1_500_000);
    });

    it('parses "1.5 ล้านบาท" → 1_500_000', () => {
      expect(parseBudgetString('1.5 ล้านบาท')).toBe(1_500_000);
    });

    it('parses "2 ล้าน" → 2_000_000', () => {
      expect(parseBudgetString('2 ล้าน')).toBe(2_000_000);
    });

    it('parses Thai numerals "๑,๕๐๐,๐๐๐" → 1_500_000', () => {
      expect(parseBudgetString('๑,๕๐๐,๐๐๐')).toBe(1_500_000);
    });

    it('returns null for non-numeric "ไม่ระบุ"', () => {
      expect(parseBudgetString('ไม่ระบุ')).toBeNull();
    });

    it('returns null for null / undefined / empty', () => {
      expect(parseBudgetString(null)).toBeNull();
      expect(parseBudgetString(undefined)).toBeNull();
      expect(parseBudgetString('')).toBeNull();
    });

    it('returns null for zero / negative values', () => {
      expect(parseBudgetString('0')).toBeNull();
      expect(parseBudgetString('-1000')).toBeNull();
    });
  });

  describe('clampBudget', () => {
    it('clamps up when parsed < floor', () => {
      expect(clampBudget(500_000, 1_000_000)).toBe(1_000_000);
    });

    it('returns parsed unchanged when parsed >= floor', () => {
      expect(clampBudget(1_500_000, 1_000_000)).toBe(1_500_000);
      expect(clampBudget(1_000_000, 1_000_000)).toBe(1_000_000);
    });

    it('returns null when parsed is null (regardless of floor)', () => {
      expect(clampBudget(null, 1_000_000)).toBeNull();
      expect(clampBudget(null, null)).toBeNull();
    });

    it('returns parsed unchanged when floor is null (no floor)', () => {
      expect(clampBudget(500_000, null)).toBe(500_000);
      expect(clampBudget(10_000_000, null)).toBe(10_000_000);
    });
  });
});
