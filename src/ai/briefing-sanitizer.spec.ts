/**
 * Wave 31 N1 — Briefing sanitizer unit tests.
 *
 * Covers each of the three passes independently, combined behavior, the
 * escape-hatch option, null-safety, and a registry-drift guard that
 * asserts every Wave 24 criterion id has a Thai title mapping.
 */
import {
  sanitizeBriefingText,
  CRITERION_TITLE_MAP,
  SUBTYPE_TITLE_MAP,
} from './briefing-sanitizer';
import { NAKHON_RATCHASIMA_ISSUE_RULES } from './criteria/nakhon-ratchasima-issue-rules';

describe('sanitizeBriefingText — Pass A (bracketed markers)', () => {
  it('strips [GEO_GROUND_TRUTH] and preserves surrounding Thai prose', () => {
    const out = sanitizeBriefingText(
      'จากข้อมูล [GEO_GROUND_TRUTH] ไม่สามารถยืนยันได้',
    );
    expect(out).toBe('จากข้อมูล ไม่สามารถยืนยันได้');
  });

  it('strips multiple markers in one sentence', () => {
    const out = sanitizeBriefingText(
      'เริ่ม [CRITERIA] กลาง [CONFLICT_ASSESSMENT] จบ [RULES]',
    );
    expect(out).toBe('เริ่ม กลาง จบ');
  });

  it('strips END_* closer markers', () => {
    const out = sanitizeBriefingText(
      'ข้อความ [END_GEO_GROUND_TRUTH] และ [END_CONFLICT_ASSESSMENT]',
    );
    expect(out).toBe('ข้อความ และ');
  });

  it('leaves Thai-only text unchanged', () => {
    const input =
      'โครงการนี้มีวัตถุประสงค์เพื่อพัฒนาคุณภาพชีวิตของประชาชนในพื้นที่';
    expect(sanitizeBriefingText(input)).toBe(input);
  });

  it('does not match brackets containing Thai characters', () => {
    const input = 'ดูหัวข้อ [กขค] ประกอบ';
    expect(sanitizeBriefingText(input)).toBe(input);
  });
});

describe('sanitizeBriefingText — Wave 39 N2 [EXAMPLES] strip', () => {
  it('strips [EXAMPLES] and [END_EXAMPLES] markers from prose', () => {
    const input = 'จัดกิจกรรม [EXAMPLES] เวิร์กช็อป [END_EXAMPLES] ในตำบล';
    const out = sanitizeBriefingText(input);
    expect(out).not.toContain('[EXAMPLES]');
    expect(out).not.toContain('[END_EXAMPLES]');
    // Surrounding prose remains (whitespace normalized by Pass C).
    expect(out).toContain('จัดกิจกรรม');
    expect(out).toContain('เวิร์กช็อป');
    expect(out).toContain('ในตำบล');
  });

  it('strips a standalone [EXAMPLES] marker anywhere in prose', () => {
    const out = sanitizeBriefingText('เริ่ม [EXAMPLES] จบ');
    expect(out).not.toContain('[EXAMPLES]');
    expect(out).toContain('เริ่ม');
    expect(out).toContain('จบ');
  });
});

describe('sanitizeBriefingText — Pass B (criterion IDs)', () => {
  it('replaces C4_1to4.b with Thai title prefix', () => {
    const label = CRITERION_TITLE_MAP['C4_1to4.b'];
    expect(label).toBeTruthy();
    const out = sanitizeBriefingText('ตามเกณฑ์ C4_1to4.b ที่กำหนด');
    expect(out).toBe(`ตามเกณฑ์ เกณฑ์${label} ที่กำหนด`);
    expect(out).not.toContain('C4_1to4.b');
  });

  it('replaces multiple criterion IDs in the same sentence', () => {
    const labelA = CRITERION_TITLE_MAP['C3_1.a'];
    const labelD = CRITERION_TITLE_MAP['C4_5to6.d'];
    const out = sanitizeBriefingText('สอดคล้อง C3_1.a และ C4_5to6.d');
    expect(out).toBe(`สอดคล้อง เกณฑ์${labelA} และ เกณฑ์${labelD}`);
  });

  it('replaces unknown ID with defensive fallback phrase', () => {
    const out = sanitizeBriefingText('ตามเกณฑ์ C99.z ระบุไว้');
    expect(out).toBe('ตามเกณฑ์ เกณฑ์ที่เกี่ยวข้อง ระบุไว้');
    expect(out).not.toContain('C99.z');
  });

  it('registry-drift: every registered criterion id has a title mapping', () => {
    const allIds = NAKHON_RATCHASIMA_ISSUE_RULES.flatMap((e) =>
      e.criteria.map((c) => c.id),
    );
    expect(allIds.length).toBe(21);
    for (const id of allIds) {
      expect(CRITERION_TITLE_MAP[id]).toBeTruthy();
      expect(typeof CRITERION_TITLE_MAP[id]).toBe('string');
      expect(CRITERION_TITLE_MAP[id].length).toBeGreaterThan(0);
    }
  });

  it('preserveCriterionIds: true skips Pass B', () => {
    const out = sanitizeBriefingText('ตามเกณฑ์ C1.a ที่กำหนด', {
      preserveCriterionIds: true,
    });
    expect(out).toContain('C1.a');
  });
});

describe('sanitizeBriefingText — Pass B2 — sub-type prefix phrases', () => {
  it('replaces "sub-type 4.1" with Thai label prefix', () => {
    const label = SUBTYPE_TITLE_MAP.get('4.1');
    expect(label).toBeTruthy();
    const out = sanitizeBriefingText(
      'โครงการนี้สอดคล้องกับประเด็นการพัฒนาด้านการพัฒนาเมืองใน sub-type 4.1 คือการก่อสร้าง',
    );
    expect(out).toContain(`ประเภทย่อย${label}`);
    expect(out).not.toMatch(/sub-type/i);
    expect(out).not.toContain('4.1');
  });

  it('replaces "ประเภทย่อย 3.1.1" with Thai label prefix', () => {
    const label = SUBTYPE_TITLE_MAP.get('3.1.1');
    expect(label).toBeTruthy();
    const out = sanitizeBriefingText('อยู่ในประเภทย่อย 3.1.1 อย่างชัดเจน');
    expect(out).toBe(`อยู่ในประเภทย่อย${label} อย่างชัดเจน`);
    expect(out).not.toContain('3.1.1');
  });

  it('matches case-insensitive "SUB-TYPE 2.3"', () => {
    const label = SUBTYPE_TITLE_MAP.get('2.3');
    expect(label).toBeTruthy();
    const out = sanitizeBriefingText('ตาม SUB-TYPE 2.3 ที่กำหนด');
    expect(out).toBe(`ตามประเภทย่อย${label} ที่กำหนด`);
  });

  it('replaces unknown sub-type code with defensive fallback', () => {
    const out = sanitizeBriefingText('ใน sub-type 99.9 ที่ระบุ');
    expect(out).toBe('ในประเภทย่อยที่เกี่ยวข้อง ที่ระบุ');
    expect(out).not.toMatch(/99\.9/);
    expect(out).not.toMatch(/sub-type/i);
  });

  it('does NOT touch bare decimals in budget prose', () => {
    const input = 'งบประมาณ 1.5 ล้านบาท';
    expect(sanitizeBriefingText(input)).toBe(input);
  });

  it('does NOT touch bare decimals in percentage prose', () => {
    const input = 'ลดลง 30.5 เปอร์เซ็นต์';
    expect(sanitizeBriefingText(input)).toBe(input);
  });

  it('registry-drift: every registered sub-type code has a title mapping', () => {
    const allCodes = NAKHON_RATCHASIMA_ISSUE_RULES.flatMap((e) =>
      e.subTypes.map((s) => s.code),
    );
    // 2 + 5 + 5 + 1 + 4 + 2 = 19
    expect(allCodes.length).toBe(19);
    for (const code of allCodes) {
      const title = SUBTYPE_TITLE_MAP.get(code);
      expect(title).toBeTruthy();
      expect(typeof title).toBe('string');
      expect((title as string).length).toBeGreaterThan(0);
    }
    expect(SUBTYPE_TITLE_MAP.size).toBe(19);
  });

  it('combined: bracketed marker + criterion ID + sub-type phrase all cleaned', () => {
    const critLabel = CRITERION_TITLE_MAP['C4_1to4.a'];
    const subLabel = SUBTYPE_TITLE_MAP.get('4.1');
    const input =
      'จากข้อมูล [CRITERIA] ตรงตามเกณฑ์ C4_1to4.a ใน sub-type 4.1 ที่ระบุ';
    const out = sanitizeBriefingText(input);
    expect(out).not.toContain('[CRITERIA]');
    expect(out).not.toContain('C4_1to4.a');
    expect(out).not.toMatch(/sub-type/i);
    expect(out).toContain(`เกณฑ์${critLabel}`);
    expect(out).toContain(`ประเภทย่อย${subLabel}`);
  });

  it('preserveSubtypeCodes: true skips Pass B2', () => {
    const out = sanitizeBriefingText('ใน sub-type 4.1 ที่ระบุ', {
      preserveSubtypeCodes: true,
    });
    expect(out).toContain('sub-type 4.1');
  });
});

describe('sanitizeBriefingText — Pass C (whitespace / punctuation)', () => {
  it('collapses double spaces', () => {
    expect(sanitizeBriefingText('foo  bar')).toBe('foo bar');
  });

  it('strips orphan space before comma', () => {
    expect(sanitizeBriefingText('foo ,bar')).toBe('foo,bar');
  });

  it('collapses double commas', () => {
    expect(sanitizeBriefingText('foo,,bar')).toBe('foo,bar');
    expect(sanitizeBriefingText('foo, ,bar')).toBe('foo,bar');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeBriefingText('   foo   ')).toBe('foo');
  });
});

describe('sanitizeBriefingText — combined real-world leaks', () => {
  it('cleans a full production-style leak (markers + criterion + junk space)', () => {
    const label = CRITERION_TITLE_MAP['C4_1to4.b'];
    const input =
      'โครงการสอดคล้องกับ [CRITERIA] ตรงตามเกณฑ์ C4_1to4.b  ,  ที่กำหนดไว้';
    const out = sanitizeBriefingText(input);
    expect(out).not.toContain('[CRITERIA]');
    expect(out).not.toContain('C4_1to4.b');
    expect(out).toContain(`เกณฑ์${label}`);
    // No double spaces, no orphan punctuation spacing.
    expect(out).not.toMatch(/ {2,}/);
    expect(out).not.toMatch(/\s,/);
  });

  it('is a no-op on marker-free / id-free STRATEGY_BASED-style prose', () => {
    const input =
      'โครงการปรับปรุงถนนสายหลักในเขตเทศบาล เพื่อลดปัญหาการจราจรและเพิ่มความปลอดภัย';
    expect(sanitizeBriefingText(input)).toBe(input);
  });
});

describe('sanitizeBriefingText — null-safety', () => {
  it('returns empty string for null input', () => {
    expect(sanitizeBriefingText(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(sanitizeBriefingText(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeBriefingText('')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    // @ts-expect-error — deliberately testing runtime coercion
    expect(sanitizeBriefingText(42)).toBe('');
    // @ts-expect-error — deliberately testing runtime coercion
    expect(sanitizeBriefingText({})).toBe('');
  });
});

describe('sanitizeBriefingText — idempotence', () => {
  it('produces identical output when applied twice', () => {
    const input =
      'จากข้อมูล [GEO_GROUND_TRUTH] ตามเกณฑ์ C3_2.c  ไม่พบข้อมูลเพียงพอ';
    const once = sanitizeBriefingText(input);
    const twice = sanitizeBriefingText(once);
    expect(twice).toBe(once);
  });
});
