/**
 * W68-FIX-05 (2026-04-28) — verbose-fields gate + verbose-mode hint
 * footer for `listProjectsInPlan` `renderedMarkdown`.
 *
 * Source of truth:
 *   - CLAUDE.md §17.2 advisory-only (verbose toggle is display-only)
 *   - CLAUDE.md §17.9 schema-strict (new param is `boolean` with a
 *     default; ancestor schema declares `additionalProperties: false`)
 *   - CLAUDE.md §17.11 no role exemption
 *   - Prompt rule #30 (executive-chat-system-prompt.ts) — opt-in
 *     verbose-mode trigger words
 *   - W66 anti-prose-translation lock — hint copy is fixed; not
 *     LLM-prose-generated
 *
 * Spec coverage:
 *   1. Default mode (verbose absent / false) — none of the five
 *      verbose lines appear; the hint footer is appended at the end.
 *   2. Verbose mode (verbose=true) — all five verbose lines render
 *      (when their source data is present); the hint footer is
 *      ABSENT (verbose users do not need the opt-in hint).
 *   3. Tool registry — `listProjectsInPlan.paramsSchema` declares
 *      `verbose: { type: 'boolean', default: false }`, and the
 *      `additionalProperties: false` invariant is preserved.
 */
import {
  GroupedProjectRound,
  VERBOSE_MODE_HINT_FOOTER,
  renderBookCompletenessMarkdown,
} from '../handlers/executive-tool-handlers';
import { EXECUTIVE_TOOL_REGISTRY } from '../tool-registry';

/**
 * Build a single-bucket `GroupedProjectRound` carrying one fully-
 * populated project row. The row exercises every verbose field
 * (objective / goal / expected) plus the §16.5-mutually-exclusive
 * pair (indicator OR developmentIssueLabel) so both
 * STRATEGY_BASED-shaped + ISSUE_BASED-shaped expectations can be
 * asserted from the same fixture.
 */
function buildFixtureGroups(): GroupedProjectRound[] {
  return [
    {
      revisionRoundType: 'main',
      revisionRoundId: null,
      revisionRoundLabel: 'เล่มหลัก',
      projects: [
        {
          projectId: '11111111-1111-1111-1111-111111111111',
          projectKind: 'original',
          name: 'โครงการทดสอบหนึ่ง',
          currentStatus: 'Approved',
          statusTh: 'อนุมัติ',
          executiveStatus: 'approved',
          planId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          budget: 1500000,
          responsibleAgencyName: 'กองยุทธศาสตร์และงบประมาณ',
          responsibleAgencyDisclosure: null,
          revisionRoundType: 'main',
          revisionRoundId: null,
          revisionRoundLabel: 'เล่มหลัก',
          pageNumber: 7,
          objective: 'เพื่อพัฒนาคุณภาพชีวิตของประชาชน',
          objectiveTruncated: false,
          goal: 'ยกระดับคุณภาพชีวิตประชาชนในพื้นที่',
          goalTruncated: false,
          expected: 'ประชาชนมีคุณภาพชีวิตดีขึ้น',
          expectedTruncated: false,
          // STRATEGY_BASED row — `indicator` populated; issue label null
          indicator: 'ร้อยละประชาชนที่ได้รับประโยชน์ ≥ 80%',
          developmentIssueLabel: null,
          amphoeName: 'อำเภอเมืองนครราชสีมา',
          laoName: 'อบจ.นครราชสีมา',
          geoCoordinates: null,
        },
      ],
    },
  ];
}

describe('W68-FIX-05 — renderBookCompletenessMarkdown verbose gate', () => {
  describe('default mode (verbose absent)', () => {
    it('does NOT contain any of the five verbose-field labels', () => {
      const md = renderBookCompletenessMarkdown(buildFixtureGroups());
      expect(md).not.toContain('วัตถุประสงค์');
      expect(md).not.toContain('เป้าหมาย');
      expect(md).not.toContain('ผลที่คาดว่าจะได้รับ');
      expect(md).not.toContain('ตัวชี้วัด');
      expect(md).not.toContain('ประเด็นการพัฒนา');
    });

    it('still contains the five core fields per rule #30', () => {
      const md = renderBookCompletenessMarkdown(buildFixtureGroups());
      // Heading + bullet + 4 core lines (status / agency / budget / page)
      expect(md).toContain('### เล่มหลัก');
      expect(md).toContain('1. **โครงการทดสอบหนึ่ง**');
      expect(md).toContain('   - สถานะ: อนุมัติ');
      expect(md).toContain('   - หน่วยงานรับผิดชอบ: กองยุทธศาสตร์และงบประมาณ');
      expect(md).toContain('   - งบประมาณ: 1,500,000 บาท');
      expect(md).toContain('   - หน้า: 7');
    });

    it('ends with the verbose-mode hint footer (Q4)', () => {
      const md = renderBookCompletenessMarkdown(buildFixtureGroups());
      expect(md.endsWith(VERBOSE_MODE_HINT_FOOTER)).toBe(true);
      // Defensive — italic markdown formatting preserved (W66 anti-
      // prose-translation lock; copy is byte-stable).
      expect(md).toContain(
        '_(แสดงเฉพาะคอลัมน์หลัก — ขอ "พร้อมรายละเอียด" เพื่อดูทุกคอลัมน์)_',
      );
    });
  });

  describe('default mode (verbose=false explicit)', () => {
    it('renders identically to the absent-verbose case', () => {
      const groups = buildFixtureGroups();
      const implicit = renderBookCompletenessMarkdown(groups);
      const explicit = renderBookCompletenessMarkdown(groups, {
        verbose: false,
      });
      expect(explicit).toBe(implicit);
    });
  });

  describe('verbose mode (verbose=true)', () => {
    it('contains all five verbose-field labels (with their values)', () => {
      const md = renderBookCompletenessMarkdown(buildFixtureGroups(), {
        verbose: true,
      });
      // STRATEGY_BASED fixture renders ตัวชี้วัด; ISSUE_BASED rows
      // would render ประเด็นการพัฒนา. Check ตัวชี้วัด here; the
      // ISSUE_BASED branch is exercised in the next test.
      expect(md).toContain('   - วัตถุประสงค์:');
      expect(md).toContain('   - เป้าหมาย:');
      expect(md).toContain('   - ผลที่คาดว่าจะได้รับ:');
      expect(md).toContain('   - ตัวชี้วัด:');
    });

    it('does NOT append the verbose-mode hint footer', () => {
      const md = renderBookCompletenessMarkdown(buildFixtureGroups(), {
        verbose: true,
      });
      expect(md.includes(VERBOSE_MODE_HINT_FOOTER)).toBe(false);
    });

    it('renders ประเด็นการพัฒนา for ISSUE_BASED rows (§16.5 mutex)', () => {
      const groups = buildFixtureGroups();
      // Flip the row to the ISSUE_BASED shape (indicator null, label set)
      const project = groups[0].projects[0];
      project.indicator = null;
      project.developmentIssueLabel = 'ประเด็นการพัฒนาด้านโครงสร้างพื้นฐาน';
      const md = renderBookCompletenessMarkdown(groups, { verbose: true });
      expect(md).toContain(
        '   - ประเด็นการพัฒนา: ประเด็นการพัฒนาด้านโครงสร้างพื้นฐาน',
      );
      // The mutually-exclusive ตัวชี้วัด line MUST NOT appear when
      // indicator is null.
      expect(md).not.toContain('   - ตัวชี้วัด:');
    });
  });

  describe('empty input', () => {
    it('returns an empty string and DOES NOT append the hint', () => {
      const md = renderBookCompletenessMarkdown([]);
      expect(md).toBe('');
      // Avoid attaching a hint to an empty body — would just dangle.
      expect(md.includes(VERBOSE_MODE_HINT_FOOTER)).toBe(false);
    });
  });
});

describe('W68-FIX-05 — listProjectsInPlan tool registry', () => {
  it('declares paramsSchema.properties.verbose as boolean default false', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;
    expect(spec).toBeDefined();
    const verboseSchema = spec.paramsSchema.properties?.verbose;
    expect(verboseSchema).toEqual({ type: 'boolean', default: false });
  });

  it('preserves additionalProperties: false on the params root', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;
    expect(spec.paramsSchema.additionalProperties).toBe(false);
  });

  it('tool description references W68-FIX-05 + verbose param + rule #30 trigger words', () => {
    const desc = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan.description;
    expect(desc).toContain('W68-FIX-05');
    expect(desc).toContain('verbose');
    // At least one rule #30 trigger word must be cited verbatim so the
    // LLM can match against user-message text.
    expect(desc).toContain('ทุกคอลัมน์');
    expect(desc).toContain('พร้อมรายละเอียด');
  });
});
