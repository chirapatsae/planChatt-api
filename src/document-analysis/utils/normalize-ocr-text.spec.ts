import {
  normalizeOcrText,
  NORMALIZE_OCR_DEFAULTS,
} from './normalize-ocr-text';

describe('normalizeOcrText', () => {
  describe('T1/T2 — empty + whitespace-only input', () => {
    it('T1: returns "" for empty string', () => {
      expect(normalizeOcrText('')).toBe('');
    });

    it('T2: returns "" for whitespace-only input', () => {
      expect(normalizeOcrText('   \n\t  \r\n   ')).toBe('');
    });
  });

  describe('T3 — consecutive duplicate line collapse', () => {
    it('collapses three identical consecutive lines to one', () => {
      const input = ['สำเนา หนังสือราชการ', 'สำเนา หนังสือราชการ', 'สำเนา หนังสือราชการ'].join(
        '\n',
      );
      const out = normalizeOcrText(input);
      // Single occurrence after consecutive collapse; below the ≥4 doc-wide
      // boilerplate threshold, so NOT dropped. Expect the single line.
      expect(out).toBe('สำเนา หนังสือราชการ');
    });

    it('collapses consecutive duplicates but keeps separated distinct content', () => {
      const input = [
        'หัวข้อ ก',
        'หัวข้อ ก',
        'ข้อความเนื้อหา ก',
        'หัวข้อ ข',
        'หัวข้อ ข',
        'ข้อความเนื้อหา ข',
      ].join('\n');
      const out = normalizeOcrText(input);
      expect(out.split('\n')).toEqual([
        'หัวข้อ ก',
        'ข้อความเนื้อหา ก',
        'หัวข้อ ข',
        'ข้อความเนื้อหา ข',
      ]);
    });
  });

  describe('T4 — doc-wide boilerplate drop (≥4 occurrences)', () => {
    it('drops a header that appears once per page across 5 pages', () => {
      const header = 'สำนักงานเขตพื้นที่การศึกษาประถมศึกษา';
      const pages = [
        [header, 'เนื้อหาหน้า 1 ย่อหน้า ก'].join('\n'),
        [header, 'เนื้อหาหน้า 2 ย่อหน้า ข'].join('\n'),
        [header, 'เนื้อหาหน้า 3 ย่อหน้า ค'].join('\n'),
        [header, 'เนื้อหาหน้า 4 ย่อหน้า ง'].join('\n'),
        [header, 'เนื้อหาหน้า 5 ย่อหน้า จ'].join('\n'),
      ];
      const input = pages.join('\n');
      const out = normalizeOcrText(input);
      expect(out).not.toContain(header);
      expect(out).toContain('เนื้อหาหน้า 1');
      expect(out).toContain('เนื้อหาหน้า 5');
    });

    it('does NOT drop content lines that appear only 3 times (below threshold)', () => {
      const repeated = 'ย่อหน้าสำคัญที่เน้นสามครั้ง';
      const input = [
        repeated,
        'เนื้อหาเติม 1',
        repeated,
        'เนื้อหาเติม 2',
        repeated,
      ].join('\n');
      const out = normalizeOcrText(input);
      // Appears 3 times, threshold is 4 → keep all
      const occurrences = out.split(repeated).length - 1;
      expect(occurrences).toBe(3);
    });
  });

  describe('T5 — short-line min-length guard', () => {
    it('does NOT drop a short line "ฯ" even when it repeats ≥ threshold', () => {
      const input = ['ฯ', 'บรรทัด ก', 'ฯ', 'บรรทัด ข', 'ฯ', 'บรรทัด ค', 'ฯ'].join('\n');
      const out = normalizeOcrText(input);
      const short = out.split('\n').filter((l) => l === 'ฯ');
      // "ฯ" length 1 < minLineLengthForBoilerplate (default 4) → all kept
      expect(short.length).toBe(4);
    });

    it('does NOT drop a short dash divider "---"', () => {
      const input = [
        '---',
        'หัวข้อ 1',
        '---',
        'หัวข้อ 2',
        '---',
        'หัวข้อ 3',
        '---',
        'หัวข้อ 4',
      ].join('\n');
      const out = normalizeOcrText(input);
      const dashes = out.split('\n').filter((l) => l === '---');
      expect(dashes.length).toBe(4);
    });
  });

  describe('T6 — intra-line token run collapse', () => {
    it('collapses "ฯ ฯ ฯ ฯ ของ" → "ฯ ของ"', () => {
      expect(normalizeOcrText('ฯ ฯ ฯ ฯ ของ')).toBe('ฯ ของ');
    });

    it('collapses a repeating Thai word run in a single line', () => {
      expect(normalizeOcrText('โครงการ โครงการ โครงการ โครงการ พัฒนา')).toBe(
        'โครงการ พัฒนา',
      );
    });

    it('does NOT collapse a 2-token run (below default threshold of 3)', () => {
      expect(normalizeOcrText('foo foo bar')).toBe('foo foo bar');
    });

    it('collapses multiple independent runs in one line', () => {
      expect(normalizeOcrText('a a a b c c c d')).toBe('a b c d');
    });
  });

  describe('T7 — distinct content per line NOT collapsed', () => {
    it('keeps "ข้อ 1 ... ก", "ข้อ 2 ... ข", "ข้อ 3 ... ค" untouched', () => {
      const input = ['ข้อ 1 รายละเอียด ก', 'ข้อ 2 รายละเอียด ข', 'ข้อ 3 รายละเอียด ค'].join(
        '\n',
      );
      const out = normalizeOcrText(input);
      expect(out.split('\n')).toEqual([
        'ข้อ 1 รายละเอียด ก',
        'ข้อ 2 รายละเอียด ข',
        'ข้อ 3 รายละเอียด ค',
      ]);
    });
  });

  describe('T8 — repeating blank lines collapsed to a single blank', () => {
    it('collapses 5 blank lines between content into one', () => {
      const input = ['บรรทัดแรก', '', '', '', '', '', 'บรรทัดถัดไป'].join('\n');
      const out = normalizeOcrText(input);
      expect(out).toBe('บรรทัดแรก\n\nบรรทัดถัดไป');
    });
  });

  describe('T9 — idempotence', () => {
    it('normalize(normalize(x)) === normalize(x) for a realistic fixture', () => {
      // Multi-page scanned form: header + footer per page, intra-line
      // jitter, blank gaps, distinct body content per page.
      const header = 'สำนักงานเขตพื้นที่การศึกษา ประถมศึกษา จังหวัด ก';
      const footer = 'หน้า 1 ของ 5';
      const pages: string[] = [];
      for (let p = 1; p <= 5; p++) {
        pages.push(
          [
            header,
            '',
            `เรื่อง เรื่อง เรื่อง ประชุมครั้งที่ ${p}`,
            `เนื้อหา หน้า ${p} — รายละเอียดเฉพาะหน้านี้`,
            '---',
            footer,
            '',
            '',
          ].join('\n'),
        );
      }
      const input = pages.join('\n');

      const once = normalizeOcrText(input);
      const twice = normalizeOcrText(once);
      expect(twice).toBe(once);

      // Sanity — header dropped, body content preserved.
      expect(once).not.toContain(header);
      expect(once).toContain('เนื้อหา หน้า 1');
      expect(once).toContain('เนื้อหา หน้า 5');
      // Intra-line "เรื่อง เรื่อง เรื่อง" should have been collapsed.
      expect(once).not.toMatch(/เรื่อง\s+เรื่อง\s+เรื่อง/);
    });

    it('is idempotent on the empty string', () => {
      expect(normalizeOcrText(normalizeOcrText(''))).toBe('');
    });

    it('is idempotent on an all-noise fixture', () => {
      const input = 'ฯ ฯ ฯ ฯ ฯ\nฯ ฯ ฯ ฯ ฯ\nฯ ฯ ฯ ฯ ฯ';
      const once = normalizeOcrText(input);
      expect(normalizeOcrText(once)).toBe(once);
    });
  });

  describe('T10 — non-throw contract', () => {
    it('returns "" for null cast as string', () => {
      expect(normalizeOcrText(null as unknown as string)).toBe('');
    });

    it('returns "" for undefined cast as string', () => {
      expect(normalizeOcrText(undefined as unknown as string)).toBe('');
    });

    it('does not throw on a number cast as string', () => {
      expect(() => normalizeOcrText(12345 as unknown as string)).not.toThrow();
    });

    it('does not throw on an object cast as string', () => {
      expect(() =>
        normalizeOcrText({ foo: 'bar' } as unknown as string),
      ).not.toThrow();
    });

    it('does not throw on very long single-token line (no whitespace)', () => {
      const glue = 'a'.repeat(10_000);
      expect(() => normalizeOcrText(glue)).not.toThrow();
      expect(normalizeOcrText(glue)).toBe(glue);
    });
  });

  describe('T11 — Thai word legitimately starting multiple lines is NOT dropped', () => {
    it('keeps distinct "โครงการ ก/ข/ค/ง/จ" even when ≥4 occurrences', () => {
      const input = [
        'โครงการ ก',
        'โครงการ ข',
        'โครงการ ค',
        'โครงการ ง',
        'โครงการ จ',
      ].join('\n');
      const out = normalizeOcrText(input);
      expect(out.split('\n')).toEqual([
        'โครงการ ก',
        'โครงการ ข',
        'โครงการ ค',
        'โครงการ ง',
        'โครงการ จ',
      ]);
    });
  });

  describe('mixed Thai + English input', () => {
    it('treats keys case-insensitively for boilerplate detection', () => {
      const header = 'Ministry of Education';
      const input = [
        header,
        'เนื้อหา 1',
        header.toLowerCase(),
        'เนื้อหา 2',
        header.toUpperCase(),
        'เนื้อหา 3',
        header,
        'เนื้อหา 4',
      ].join('\n');
      const out = normalizeOcrText(input);
      // 4 case-variant occurrences → all dropped
      expect(out.toLowerCase()).not.toContain(header.toLowerCase());
      expect(out).toContain('เนื้อหา 1');
      expect(out).toContain('เนื้อหา 4');
    });

    it('preserves multi-paragraph structure across mixed-script content', () => {
      const input = [
        'Paragraph A start',
        'This is English line 1.',
        'บรรทัดภาษาไทยที่ 1',
        '',
        'Paragraph B start',
        'English line 2.',
        'บรรทัดภาษาไทยที่ 2',
      ].join('\n');
      const out = normalizeOcrText(input);
      // Blank line between paragraphs preserved; content unchanged.
      expect(out).toBe(input);
    });
  });

  describe('custom options', () => {
    it('respects a lowered boilerplate threshold', () => {
      const header = 'ส่วนหัวซ้ำ';
      const input = [header, 'a', header, 'b'].join('\n');
      // Default threshold (4) → 2 occurrences NOT dropped
      expect(normalizeOcrText(input)).toContain(header);
      // Custom threshold = 2 → dropped
      const out = normalizeOcrText(input, {
        boilerplateDocWideMinOccurrences: 2,
      });
      expect(out).not.toContain(header);
    });

    it('respects a raised intra-line token-run threshold', () => {
      // Default threshold 3 → "a a a" collapses
      expect(normalizeOcrText('a a a')).toBe('a');
      // Custom threshold 4 → "a a a" NOT collapsed
      expect(normalizeOcrText('a a a', { intraLineTokenRunThreshold: 4 })).toBe(
        'a a a',
      );
    });

    it('exposes default constants', () => {
      expect(NORMALIZE_OCR_DEFAULTS.boilerplateDocWideMinOccurrences).toBe(4);
      expect(NORMALIZE_OCR_DEFAULTS.consecutiveDuplicateLineThreshold).toBe(2);
      expect(NORMALIZE_OCR_DEFAULTS.intraLineTokenRunThreshold).toBe(3);
      expect(NORMALIZE_OCR_DEFAULTS.minLineLengthForBoilerplate).toBe(4);
    });
  });

  describe('line-ending normalization', () => {
    it('treats \\r\\n the same as \\n', () => {
      const crlf = 'บรรทัด 1\r\nบรรทัด 1\r\nบรรทัด 2';
      const lf = 'บรรทัด 1\nบรรทัด 1\nบรรทัด 2';
      expect(normalizeOcrText(crlf)).toBe(normalizeOcrText(lf));
    });

    it('treats stray \\r as \\n', () => {
      expect(normalizeOcrText('a\ra\rb')).toBe(normalizeOcrText('a\na\nb'));
    });
  });
});
