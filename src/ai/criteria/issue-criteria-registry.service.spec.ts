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

  // ---------------------------------------------------------------------
  // Wave Sub-Type Filter (2026-05-22) — narrow `findAllByStrategyName`
  // result to a single sub-domain when the user has clicked a sub-type
  // chip. Empty / unknown code → "general check" mode ([]).
  //
  // Bug fixed: production observation 2026-05-22 — Strategy 3 (economic)
  // pulled BOTH economic-3-1 (เกษตร) and economic-3-2 (อุตสาหกรรม/water)
  // criteria onto a farming project; the user saw the irrelevant
  // economic-3-2 evaluation at 0/5 and got a misleading score.
  // ---------------------------------------------------------------------
  describe('filterEntriesBySubType — sub-type-aware narrowing', () => {
    it('subTypeCode 3.1.1 (เกษตร) → exactly [economic-3-1]', () => {
      const all = service.findAllByStrategyName(
        'ยุทธศาสตร์ด้านการพัฒนาเศรษฐกิจ',
      );
      const filtered = service.filterEntriesBySubType(all, '3.1.1');
      expect(filtered.map((e) => e.issueKey)).toEqual(['economic-3-1']);
    });

    it('subTypeCode 3.1.2 (อุตสาหกรรม/SMEs) → exactly [economic-3-1]', () => {
      // 3.1.2 is also under economic-3-1 — labels are inner-sub-categories
      // OF that entry; both should resolve to the same parent entry.
      const all = service.findAllByStrategyName('ด้านการพัฒนาเศรษฐกิจ');
      const filtered = service.filterEntriesBySubType(all, '3.1.2');
      expect(filtered.map((e) => e.issueKey)).toEqual(['economic-3-1']);
    });

    it('subTypeCode 3.2.1 (ขุดลอกแหล่งน้ำ) → exactly [economic-3-2]', () => {
      const all = service.findAllByStrategyName('ด้านการพัฒนาเศรษฐกิจ');
      const filtered = service.filterEntriesBySubType(all, '3.2.1');
      expect(filtered.map((e) => e.issueKey)).toEqual(['economic-3-2']);
    });

    it('subTypeCode 4.1 (ก่อสร้างถนน) → exactly [urban-4-1to4]', () => {
      const all = service.findAllByStrategyName('ด้านการพัฒนาเมือง');
      const filtered = service.filterEntriesBySubType(all, '4.1');
      expect(filtered.map((e) => e.issueKey)).toEqual(['urban-4-1to4']);
    });

    it('subTypeCode 4.5 (สาธารณภัย) → exactly [urban-4-5to6]', () => {
      const all = service.findAllByStrategyName('ด้านการพัฒนาเมือง');
      const filtered = service.filterEntriesBySubType(all, '4.5');
      expect(filtered.map((e) => e.issueKey)).toEqual(['urban-4-5to6']);
    });

    it('empty subTypeCode → [] (general check mode)', () => {
      const all = service.findAllByStrategyName('ด้านการพัฒนาเศรษฐกิจ');
      expect(service.filterEntriesBySubType(all, '')).toEqual([]);
      expect(service.filterEntriesBySubType(all, '   ')).toEqual([]);
    });

    it('null / undefined subTypeCode → [] (general check mode)', () => {
      const all = service.findAllByStrategyName('ด้านการพัฒนาเศรษฐกิจ');
      expect(service.filterEntriesBySubType(all, null)).toEqual([]);
      expect(service.filterEntriesBySubType(all, undefined)).toEqual([]);
    });

    it('unknown subTypeCode → [] (defensive, NOT "all entries")', () => {
      // This is the load-bearing assertion: the prior incorrect behaviour
      // was to default to ALL entries when there was no match. We MUST
      // NOT regress to that.
      const all = service.findAllByStrategyName('ด้านการพัฒนาเศรษฐกิจ');
      expect(service.filterEntriesBySubType(all, '99.99.99')).toEqual([]);
      expect(service.filterEntriesBySubType(all, 'garbage-code')).toEqual(
        [],
      );
    });

    it('STRAT001 royal sub-types (1.1, 1.2) → [royal-initiated]', () => {
      const all = service.findAllByStrategyName(
        'ยุทธศาสตร์ด้านโครงการตามแนวพระราชดำริ',
      );
      expect(
        service.filterEntriesBySubType(all, '1.1').map((e) => e.issueKey),
      ).toEqual(['royal-initiated']);
      expect(
        service.filterEntriesBySubType(all, '1.2').map((e) => e.issueKey),
      ).toEqual(['royal-initiated']);
    });

    it('quality-of-life sub-types (2.1 — 2.5) → [quality-of-life]', () => {
      const all = service.findAllByStrategyName(
        'ยุทธศาสตร์ด้านการพัฒนาคุณภาพชีวิต',
      );
      for (const code of ['2.1', '2.2', '2.3', '2.4', '2.5']) {
        const filtered = service.filterEntriesBySubType(all, code);
        expect(filtered.map((e) => e.issueKey)).toEqual([
          'quality-of-life',
        ]);
      }
    });

    it('pure function — does not mutate input array', () => {
      const all = service.findAllByStrategyName('ด้านการพัฒนาเศรษฐกิจ');
      const before = all.map((e) => e.issueKey);
      service.filterEntriesBySubType(all, '3.1.1');
      const after = all.map((e) => e.issueKey);
      expect(after).toEqual(before);
    });
  });
});
