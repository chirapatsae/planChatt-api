import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { IssueCriteriaRegistryService } from './issue-criteria-registry.service';
import {
  extractEntryRoot,
  extractStrategyRoot,
  normalizeThaiPhrase,
} from './strategy-name.util';

/**
 * Wave LAO issue/strategy parity — BE-RESOLVER unit tests.
 *
 * Covers:
 *   1. `findAllByStrategyName` 1-to-many mapping matrix
 *      (STRAT001..STRAT005 against the FROZEN registry).
 *   2. Helper functions (`extractStrategyRoot`, `normalizeThaiPhrase`,
 *      `extractEntryRoot`) including idempotency.
 *   3. Regression on `findByIssueName` / `findByIssueId` (1-result
 *      ISSUE_BASED contract preserved byte-for-byte).
 *
 * Advisory-only per CLAUDE.md §17.2 — no workflow gating, no
 * tracking writes. Pure compute; the DevelopmentIssue repository is
 * mocked.
 */

describe('IssueCriteriaRegistryService — strategy-name pure helpers', () => {
  describe('extractStrategyRoot', () => {
    it('strips the leading "ยุทธศาสตร์" prefix', () => {
      expect(extractStrategyRoot('ยุทธศาสตร์ด้านการพัฒนาเศรษฐกิจ')).toBe(
        'ด้านการพัฒนาเศรษฐกิจ',
      );
    });

    it('trims whitespace after the prefix', () => {
      expect(extractStrategyRoot('ยุทธศาสตร์ ด้านการพัฒนาเศรษฐกิจ')).toBe(
        'ด้านการพัฒนาเศรษฐกิจ',
      );
    });

    it('is idempotent on already-stripped input (no prefix)', () => {
      expect(extractStrategyRoot('ด้านการพัฒนาเศรษฐกิจ')).toBe(
        'ด้านการพัฒนาเศรษฐกิจ',
      );
    });

    it('returns empty string for empty / whitespace input', () => {
      expect(extractStrategyRoot('')).toBe('');
      expect(extractStrategyRoot('   ')).toBe('');
    });
  });

  describe('normalizeThaiPhrase', () => {
    it('collapses "การพัฒนา" → "พัฒนา"', () => {
      expect(normalizeThaiPhrase('ด้านการพัฒนาเศรษฐกิจ')).toBe(
        'ด้านพัฒนาเศรษฐกิจ',
      );
    });

    it('collapses "แนวทาง" → "แนว"', () => {
      expect(normalizeThaiPhrase('ด้านโครงการตามแนวทางพระราชดำริ')).toBe(
        'ด้านโครงการตามแนวพระราชดำริ',
      );
    });

    it('is idempotent on already-collapsed input', () => {
      expect(normalizeThaiPhrase('ด้านพัฒนาเศรษฐกิจ')).toBe('ด้านพัฒนาเศรษฐกิจ');
      expect(normalizeThaiPhrase('ด้านโครงการตามแนวพระราชดำริ')).toBe(
        'ด้านโครงการตามแนวพระราชดำริ',
      );
    });

    it('applies NFC normalization', () => {
      // "ก" decomposed vs precomposed — passthrough check.
      const input = 'ด้านการพัฒนาเมือง';
      expect(normalizeThaiPhrase(input.normalize('NFD'))).toBe('ด้านพัฒนาเมือง');
    });
  });

  describe('extractEntryRoot', () => {
    it('returns text before the first " — " (em-dash + spaces)', () => {
      expect(
        extractEntryRoot('ด้านพัฒนาเศรษฐกิจ — แหล่งน้ำเพื่อการเกษตร'),
      ).toBe('ด้านพัฒนาเศรษฐกิจ');
    });

    it('returns the entire string when no delimiter is present', () => {
      expect(extractEntryRoot('ด้านการพัฒนาคุณภาพชีวิต')).toBe(
        'ด้านการพัฒนาคุณภาพชีวิต',
      );
    });

    it('returns empty for empty input', () => {
      expect(extractEntryRoot('')).toBe('');
    });
  });
});

describe('IssueCriteriaRegistryService — findAllByStrategyName', () => {
  let service: IssueCriteriaRegistryService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssueCriteriaRegistryService,
        {
          provide: getRepositoryToken(DevelopmentIssue),
          // findAllByStrategyName is pure; repository is unused. A no-op
          // stub satisfies DI without exercising any DB code path.
          useValue: { findOne: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<IssueCriteriaRegistryService>(
      IssueCriteriaRegistryService,
    );
  });

  it('STRAT001 → exactly [royal-initiated]', () => {
    const result = service.findAllByStrategyName(
      'ยุทธศาสตร์ด้านโครงการตามแนวพระราชดำริ',
    );
    expect(result.map((e) => e.issueKey)).toEqual(['royal-initiated']);
  });

  it('STRAT002 → exactly [quality-of-life]', () => {
    const result = service.findAllByStrategyName(
      'ยุทธศาสตร์ด้านการพัฒนาคุณภาพชีวิต',
    );
    expect(result.map((e) => e.issueKey)).toEqual(['quality-of-life']);
  });

  it('STRAT003 → [economic-3-1, economic-3-2] (order-insensitive)', () => {
    const result = service.findAllByStrategyName(
      'ยุทธศาสตร์ด้านการพัฒนาเศรษฐกิจ',
    );
    const keys = result.map((e) => e.issueKey);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(
      expect.arrayContaining(['economic-3-1', 'economic-3-2']),
    );
  });

  it('STRAT004 → [urban-4-1to4, urban-4-5to6] (order-insensitive)', () => {
    const result = service.findAllByStrategyName(
      'ยุทธศาสตร์ด้านการพัฒนาเมือง',
    );
    const keys = result.map((e) => e.issueKey);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(
      expect.arrayContaining(['urban-4-1to4', 'urban-4-5to6']),
    );
  });

  it('STRAT005 → empty array (no regulatory criteria mapped)', () => {
    const result = service.findAllByStrategyName(
      'ยุทธศาสตร์ด้านพัฒนาระบบการบริหารจัดการภาครัฐ',
    );
    expect(result).toEqual([]);
  });

  it('accepts a name WITHOUT "ยุทธศาสตร์" prefix (graceful)', () => {
    const result = service.findAllByStrategyName('ด้านการพัฒนาเศรษฐกิจ');
    const keys = result.map((e) => e.issueKey);
    expect(keys).toEqual(
      expect.arrayContaining(['economic-3-1', 'economic-3-2']),
    );
    expect(keys).toHaveLength(2);
  });

  it('rejects empty / whitespace input with BadRequestException', () => {
    expect(() => service.findAllByStrategyName('')).toThrow(
      BadRequestException,
    );
    expect(() => service.findAllByStrategyName('   ')).toThrow(
      BadRequestException,
    );
  });

  it('regression — findByIssueName still returns single entry for ISSUE_BASED names', () => {
    // 1-result contract preserved per AUDIT §7.6 #4.
    const entry = service.findByIssueName('ด้านการพัฒนาคุณภาพชีวิต');
    expect(entry?.issueKey).toBe('quality-of-life');

    const entry2 = service.findByIssueName('แหล่งน้ำเพื่อการเกษตร');
    expect(entry2?.issueKey).toBe('economic-3-2');
  });

  it('regression — findByIssueName returns null for unknown name', () => {
    expect(service.findByIssueName('ไม่มีในระบบ')).toBeNull();
    expect(service.findByIssueName(null)).toBeNull();
    expect(service.findByIssueName(undefined)).toBeNull();
  });
});
