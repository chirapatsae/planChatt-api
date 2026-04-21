/**
 * Wave 29 N2 — Unit tests for the briefing citation parser.
 *
 * Coverage target: the §17.9 schema-drift defenses in
 * `parseCitationsJsonBlock` — whitelist enforcement, malformed JSON
 * tolerance, missing-field filtering, and optional-field
 * preservation.
 */
import {
  CITATION_SOURCE_TYPE_WHITELIST,
  parseCitationsJsonBlock,
  sanitizeCitationEntry,
} from './citation-parser';

describe('parseCitationsJsonBlock', () => {
  function wrap(jsonBlock: string): string {
    return `ป้ายพื้นที่: ชุมชน\n\n**การอ้างอิง (JSON):**\n${jsonBlock}`;
  }

  it('returns a sanitized list for a well-formed citations array', () => {
    const raw = wrap(
      JSON.stringify({
        citations: [
          {
            label: 'ปี 2569 ประชากรตำบลโคกกรวด',
            sourceType: 'registry-stat',
            sourceRef: 'tambon-khok-kruat-population-2569',
            description: 'ข้อมูลประชากรจากทะเบียนราษฎร์ปี 2569',
          },
        ],
      }),
    );
    const result = parseCitationsJsonBlock(raw);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].label).toBe('ปี 2569 ประชากรตำบลโคกกรวด');
    expect(result![0].sourceType).toBe('registry-stat');
    expect(result![0].sourceRef).toBe(
      'tambon-khok-kruat-population-2569',
    );
    expect(result![0].description).toBe(
      'ข้อมูลประชากรจากทะเบียนราษฎร์ปี 2569',
    );
  });

  it('drops entries whose sourceType is not in the whitelist', () => {
    const raw = wrap(
      JSON.stringify({
        citations: [
          { label: 'ok', sourceType: 'registry-stat' },
          { label: 'spoof', sourceType: 'malicious-override' },
          { label: 'empty-type', sourceType: '' },
          { label: 'numeric-type', sourceType: 42 },
        ],
      }),
    );
    const result = parseCitationsJsonBlock(raw);
    expect(result).toEqual([
      { label: 'ok', sourceType: 'registry-stat' },
    ]);
  });

  it('drops entries missing the required `label` field', () => {
    const raw = wrap(
      JSON.stringify({
        citations: [
          { sourceType: 'criterion' },
          { label: '   ', sourceType: 'criterion' },
          { label: 'kept', sourceType: 'criterion' },
        ],
      }),
    );
    const result = parseCitationsJsonBlock(raw);
    expect(result).toEqual([
      { label: 'kept', sourceType: 'criterion' },
    ]);
  });

  it('returns null when the marker block is absent', () => {
    const raw = 'ชื่อโครงการ: foo\nไม่มีบล็อคอ้างอิง';
    expect(parseCitationsJsonBlock(raw)).toBeNull();
  });

  it('returns null when the JSON block is malformed (does not throw)', () => {
    const raw = wrap('{ "citations": [ { "label": "x", "sourceType": ');
    expect(() => parseCitationsJsonBlock(raw)).not.toThrow();
    expect(parseCitationsJsonBlock(raw)).toBeNull();
  });

  it('returns null when citations value is not an array', () => {
    const raw = wrap(JSON.stringify({ citations: 'not-an-array' }));
    expect(parseCitationsJsonBlock(raw)).toBeNull();
  });

  it('preserves entries that omit optional fields (sourceRef, description)', () => {
    const raw = wrap(
      JSON.stringify({
        citations: [{ label: 'minimal', sourceType: 'issue-rule' }],
      }),
    );
    const result = parseCitationsJsonBlock(raw);
    expect(result).toEqual([
      { label: 'minimal', sourceType: 'issue-rule' },
    ]);
    expect(result![0].sourceRef).toBeUndefined();
    expect(result![0].description).toBeUndefined();
  });

  it('accepts a bare top-level array after the marker', () => {
    const raw = wrap(
      JSON.stringify([
        { label: 'bare', sourceType: 'geo-feature', sourceRef: 'feature:1' },
      ]),
    );
    const result = parseCitationsJsonBlock(raw);
    expect(result).toEqual([
      { label: 'bare', sourceType: 'geo-feature', sourceRef: 'feature:1' },
    ]);
  });

  it('drops sourceRef with non-ASCII / punctuation-heavy content', () => {
    const raw = wrap(
      JSON.stringify({
        citations: [
          {
            label: 'bad-ref',
            sourceType: 'amphoe-dossier',
            sourceRef: 'อำเภอโคกกรวด',
          },
        ],
      }),
    );
    const result = parseCitationsJsonBlock(raw);
    // The entry with an invalid sourceRef is rejected outright.
    expect(result).toEqual([]);
  });

  it('caps oversized arrays to protect downstream memory / tokens', () => {
    const tooMany = Array.from({ length: 50 }, (_, i) => ({
      label: `c-${i}`,
      sourceType: 'criterion',
    }));
    const raw = wrap(JSON.stringify({ citations: tooMany }));
    const result = parseCitationsJsonBlock(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(12);
  });

  it('whitelist matches the canonical set from the task contract', () => {
    expect([...CITATION_SOURCE_TYPE_WHITELIST].sort()).toEqual(
      [
        'geo-feature',
        'amphoe-dossier',
        'criterion',
        'issue-rule',
        'registry-stat',
        'user-pin',
      ].sort(),
    );
  });
});

describe('sanitizeCitationEntry', () => {
  it('rejects non-object inputs', () => {
    expect(sanitizeCitationEntry(null)).toBeNull();
    expect(sanitizeCitationEntry(undefined)).toBeNull();
    expect(sanitizeCitationEntry('string')).toBeNull();
    expect(sanitizeCitationEntry(42)).toBeNull();
  });

  it('truncates overly long labels', () => {
    const long = 'A'.repeat(500);
    const out = sanitizeCitationEntry({
      label: long,
      sourceType: 'registry-stat',
    });
    expect(out).not.toBeNull();
    expect(out!.label.length).toBeLessThanOrEqual(120);
  });
});
