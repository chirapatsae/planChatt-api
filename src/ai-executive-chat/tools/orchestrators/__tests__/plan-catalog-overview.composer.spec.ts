/**
 * Wave AI-EXEC-CHAT-ENTERPRISE-OUTPUT-TONE / BE-01 — composer tests.
 *
 * Q1-Q5 lock acknowledgement (verbatim from
 * docs/tasks/wave-ai-exec-chat-enterprise-output-tone/README.md §0):
 *   Q1 — 'none' activity badge → SILENCE
 *   Q2 — Bullet rendering enforcement → server-side pre-render via
 *        `renderedMarkdown` envelope field
 *   Q3 — Empty-bucket negative-space → renderer never produces empty
 *        bullets
 *   Q4 — No other fragile rules
 *   Q5 — Rule #48 "Enterprise Output Bar" appended (BE-02 concern)
 *
 * The composer is a pure function: input is a deterministic plan +
 * sub-book record set; output is a markdown string + counter metadata.
 * No DI, no Logger, no LLM input. The handler-level test surface
 * (fan-out, telemetry, role guard) is intentionally exercised below as
 * well via a small subset of tests using the EXECUTIVE_TOOL_HANDLERS
 * shim — see "telemetry hook" describe block.
 */

import { Logger } from '@nestjs/common';
import {
  composePlanCatalogMarkdown,
  composePlanCatalogSummaryLine,
  applyEquipmentCounts,
  emitTelemetry,
  PlanEntry,
  RevisionEntry,
  SupplementEntry,
  PLAN_CATALOG_TELEMETRY_LABEL,
} from '../plan-catalog-overview.orchestrator';
import type { EquipmentChildBookCounts } from '../../../aggregation/services/unified-equipment-aggregator.service';

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<PlanEntry> = {}): PlanEntry {
  return {
    planId: overrides.planId ?? 'plan-1',
    name: overrides.name ?? 'แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570',
    reportFormat: overrides.reportFormat ?? 'STRATEGY_BASED',
    reportFormatLabel: overrides.reportFormatLabel ?? 'แบบยุทธศาสตร์',
    isLatest: overrides.isLatest ?? true,
    isBooked: overrides.isBooked ?? false,
    // Default 0 (was 1) — the main-book PROJECT segment (B3, 2026-07-18) is
    // silent at zero, so structure/activity tests that don't assert on the
    // project count stay byte-identical. Tests that verify the segment set
    // `projectCount` explicitly (see "main-book project segment" test).
    projectCount: overrides.projectCount ?? 0,
    // Optional ผ.03 count — pass through so `makePlan({ equipmentCount })`
    // actually reaches the composer (was silently dropped: no spread here).
    equipmentCount: overrides.equipmentCount,
    planActivityStatus: overrides.planActivityStatus ?? {
      freshness: 'latest',
      freshnessLabel: 'เล่มล่าสุด',
      activities: [{ key: 'none', label: 'ไม่มีกิจกรรมเปิด' }],
    },
  };
}

function makeRevision(overrides: Partial<RevisionEntry> = {}): RevisionEntry {
  return {
    revisionId: overrides.revisionId ?? 'rev-1',
    revisionNumber: overrides.revisionNumber ?? 1,
    revisionTypeName: overrides.revisionTypeName ?? 'แก้ไข',
    isLatest: overrides.isLatest ?? true,
    isOpen: overrides.isOpen ?? false,
    isBooked: overrides.isBooked ?? false,
    projectCount: overrides.projectCount ?? 1,
    equipmentCount: overrides.equipmentCount,
    roundLabel: overrides.roundLabel,
  };
}

function makeSupplement(
  overrides: Partial<SupplementEntry> = {},
): SupplementEntry {
  return {
    supplementId: overrides.supplementId ?? 'sup-1',
    supplementNumber: overrides.supplementNumber ?? 1,
    isLatest: overrides.isLatest ?? true,
    isOpen: overrides.isOpen ?? false,
    isBooked: overrides.isBooked ?? false,
    projectCount: overrides.projectCount ?? 1,
    equipmentCount: overrides.equipmentCount,
    roundLabel: overrides.roundLabel,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Composer tests
// ──────────────────────────────────────────────────────────────────────

describe('BE-01 / composePlanCatalogMarkdown', () => {
  describe('AC-1 — empty plan list', () => {
    it('returns empty renderedMarkdown and zero counters', () => {
      const result = composePlanCatalogMarkdown({
        plans: [],
        revisionsByPlanId: {},
        supplementsByPlanId: {},
      });
      expect(result.renderedMarkdown).toBe('');
      expect(result.expandedPlans).toBe(0);
      expect(result.deferredPlans).toBe(0);
    });
  });

  describe("Q1 — 'none' activity badge SILENCE", () => {
    it('plan with activities = [{key:none}] emits header with NO " · ไม่มีกิจกรรมเปิด" suffix', () => {
      const plan = makePlan({
        planActivityStatus: {
          freshness: 'latest',
          freshnessLabel: 'เล่มล่าสุด',
          activities: [{ key: 'none', label: 'ไม่มีกิจกรรมเปิด' }],
        },
      });
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: {},
        supplementsByPlanId: {},
      });
      expect(result.renderedMarkdown).not.toContain('ไม่มีกิจกรรมเปิด');
      expect(result.renderedMarkdown).not.toContain('(none)');
      expect(result.renderedMarkdown).not.toContain('· none');
      // The header MUST end at the freshness label — nothing after.
      expect(result.renderedMarkdown).toBe(
        '**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด',
      );
    });

    it('plan with empty activities[] emits header with NO suffix', () => {
      const plan = makePlan({
        planActivityStatus: {
          freshness: 'latest',
          freshnessLabel: 'เล่มล่าสุด',
          activities: [],
        },
      });
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: {},
        supplementsByPlanId: {},
      });
      expect(result.renderedMarkdown).toBe(
        '**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด',
      );
    });

    it('plan with submit-open activity DOES emit positive suffix', () => {
      const plan = makePlan({
        planActivityStatus: {
          freshness: 'latest',
          freshnessLabel: 'เล่มล่าสุด',
          activities: [{ key: 'submit-open', label: 'เปิดส่งโครงการ' }],
        },
      });
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: {},
        supplementsByPlanId: {},
      });
      expect(result.renderedMarkdown).toBe(
        '**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด · เปิดส่งโครงการ',
      );
    });
  });

  describe('Q3 — empty sub-book bucket SILENCE', () => {
    it('plan with zero revisions + zero supplements emits header only — no bullets', () => {
      const plan = makePlan({
        planId: 'plan-X',
        name: 'แผนเก่า',
        isLatest: false,
        planActivityStatus: {
          freshness: 'historical',
          freshnessLabel: 'เล่มเก่า',
          activities: [],
        },
      });
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: { 'plan-X': [] },
        supplementsByPlanId: { 'plan-X': [] },
      });
      // Single line, no trailing bullets, no negative-space text.
      expect(result.renderedMarkdown).toBe('**แผนเก่า** — เล่มเก่า');
      // Specifically MUST NOT contain any "ไม่มี…" sentence.
      expect(result.renderedMarkdown).not.toMatch(/ไม่มี/);
      // Must NOT contain a CommonMark bullet marker.
      expect(result.renderedMarkdown).not.toMatch(/^- /m);
    });
  });

  describe('AC-2 — canonical case (1 plan + 1 revision + 0 supplements)', () => {
    it('emits Rule #47 layout byte-for-byte', () => {
      const plan = makePlan({
        planActivityStatus: {
          freshness: 'latest',
          freshnessLabel: 'เล่มล่าสุด',
          activities: [{ key: 'none', label: 'ไม่มีกิจกรรมเปิด' }],
        },
      });
      const rev = makeRevision({
        revisionNumber: 1,
        revisionTypeName: 'แก้ไข',
        isOpen: false,
        projectCount: 1,
      });
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: { 'plan-1': [rev] },
        supplementsByPlanId: { 'plan-1': [] },
      });
      // Header has NO " · ไม่มีกิจกรรมเปิด"; bullet contains revision only;
      // NO "ไม่มีเล่มเพิ่มเติม" line.
      expect(result.renderedMarkdown).toBe(
        '**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด\n' +
          '- เล่มแก้ไขครั้งที่ 1 — ปิดอยู่ · มีโครงการ 1 โครงการ',
      );
      expect(result.renderedMarkdown).not.toMatch(/ไม่มีเล่มเพิ่มเติม/);
      expect(result.renderedMarkdown).not.toMatch(/ไม่มีเล่ม/);
    });
  });

  describe('AC plan with all 3 sub-book types', () => {
    it('renders edit + change + supplement bullets in canonical order', () => {
      const plan = makePlan();
      const revs = [
        makeRevision({
          revisionId: 'r1',
          revisionNumber: 1,
          revisionTypeName: 'แก้ไข',
          isOpen: false,
          projectCount: 3,
        }),
        makeRevision({
          revisionId: 'r2',
          revisionNumber: 1,
          revisionTypeName: 'เปลี่ยนแปลง',
          isOpen: true,
          projectCount: 2,
        }),
      ];
      const sups = [
        makeSupplement({
          supplementId: 's1',
          supplementNumber: 1,
          isOpen: false,
          projectCount: 5,
        }),
      ];
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: { 'plan-1': revs },
        supplementsByPlanId: { 'plan-1': sups },
      });
      // edit before change; revisions before supplements.
      const lines = result.renderedMarkdown.split('\n');
      expect(lines[0]).toBe('**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด');
      expect(lines[1]).toBe(
        '- เล่มแก้ไขครั้งที่ 1 — ปิดอยู่ · มีโครงการ 3 โครงการ',
      );
      expect(lines[2]).toBe(
        '- เล่มเปลี่ยนแปลงครั้งที่ 1 — กำลังเปิดรับ · มีโครงการ 2 โครงการ',
      );
      expect(lines[3]).toBe(
        '- เล่มเพิ่มเติมครั้งที่ 1 — ปิดอยู่ · มีโครงการ 5 โครงการ',
      );
    });
  });

  describe('AC-5 — 6 plans (>5 cap)', () => {
    it('only latest plans expand; older plans get COLLAPSED_HINT_SUFFIX', () => {
      const latest = makePlan({
        planId: 'p-latest',
        name: 'แผนล่าสุด',
        isLatest: true,
      });
      const older = Array.from({ length: 5 }).map((_, i) =>
        makePlan({
          planId: `p-old-${i}`,
          name: `แผนเก่า ${i}`,
          isLatest: false,
          planActivityStatus: {
            freshness: 'historical',
            freshnessLabel: 'เล่มเก่า',
            activities: [],
          },
        }),
      );
      const plans = [latest, ...older];

      const rev = makeRevision({ revisionNumber: 1, projectCount: 1 });
      const revisionsByPlanId: Record<string, RevisionEntry[]> = {
        'p-latest': [rev],
      };
      // Older plans also "have" sub-books in the lookup, but they should
      // NOT be expanded under token-budget mitigation.
      for (const p of older) {
        revisionsByPlanId[p.planId] = [rev];
      }

      const result = composePlanCatalogMarkdown({
        plans,
        revisionsByPlanId,
        supplementsByPlanId: {},
      });

      // Latest plan should show its bullet.
      expect(result.renderedMarkdown).toContain(
        '**แผนล่าสุด** — เล่มล่าสุด\n- เล่มแก้ไขครั้งที่ 1',
      );
      // Older plans should carry the collapsed hint suffix.
      for (const o of older) {
        expect(result.renderedMarkdown).toContain(
          `**${o.name}** — เล่มเก่า (ดูเล่มย่อยได้เมื่อต้องการ)`,
        );
      }
      // Older plans MUST NOT show their bullets despite having data.
      const olderHeaders = result.renderedMarkdown
        .split('\n\n')
        .filter((b) => b.includes('แผนเก่า'));
      for (const block of olderHeaders) {
        expect(block).not.toMatch(/^- /m);
      }
      // Counter checks: 1 expanded + 5 deferred.
      expect(result.expandedPlans).toBe(1);
      expect(result.deferredPlans).toBe(5);
    });
  });

  describe('AC overflow — 12 revisions in one plan', () => {
    it('renders first 10 + "(+2 เล่มอื่น)" footer bullet', () => {
      const plan = makePlan();
      const revs = Array.from({ length: 12 }).map((_, i) =>
        makeRevision({
          revisionId: `r-${i}`,
          revisionNumber: i + 1,
          revisionTypeName: 'แก้ไข',
          projectCount: 1,
        }),
      );
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: { 'plan-1': revs },
        supplementsByPlanId: {},
      });
      const lines = result.renderedMarkdown.split('\n');
      // 1 header + 10 revision bullets + 1 overflow bullet = 12 lines.
      expect(lines).toHaveLength(12);
      expect(lines[10]).toBe(
        '- เล่มแก้ไขครั้งที่ 10 — ปิดอยู่ · มีโครงการ 1 โครงการ',
      );
      expect(lines[11]).toBe('- (+2 เล่มอื่น)');
    });
  });

  describe('format — CommonMark hyphen bullet + double newline between plans', () => {
    it('separates plan blocks with a single blank line', () => {
      const p1 = makePlan({
        planId: 'p1',
        name: 'แผน A',
        planActivityStatus: {
          freshness: 'latest',
          freshnessLabel: 'เล่มล่าสุด',
          activities: [],
        },
      });
      const p2 = makePlan({
        planId: 'p2',
        name: 'แผน B',
        isLatest: false,
        planActivityStatus: {
          freshness: 'historical',
          freshnessLabel: 'เล่มเก่า',
          activities: [],
        },
      });
      const result = composePlanCatalogMarkdown({
        plans: [p1, p2],
        revisionsByPlanId: {
          p1: [
            makeRevision({
              revisionNumber: 1,
              revisionTypeName: 'แก้ไข',
              projectCount: 1,
            }),
          ],
          p2: [],
        },
        supplementsByPlanId: {},
      });
      expect(result.renderedMarkdown).toBe(
        '**แผน A** — เล่มล่าสุด\n' +
          '- เล่มแก้ไขครั้งที่ 1 — ปิดอยู่ · มีโครงการ 1 โครงการ' +
          '\n\n' +
          '**แผน B** — เล่มเก่า',
      );
      // Bullet marker is CommonMark hyphen-space at column 0 (no indent).
      expect(result.renderedMarkdown).toMatch(/\n- /);
      // No Unicode `•` bullet glyph leakage in the source markdown.
      expect(result.renderedMarkdown).not.toContain('•');
      // No leading-space indent before the hyphen marker.
      expect(result.renderedMarkdown).not.toMatch(/\n {1,}- /);
    });
  });

  describe('mixed sub-book sort order', () => {
    it('edit before change; revisions before supplements', () => {
      const plan = makePlan();
      const revs = [
        // Intentionally insert out of order.
        makeRevision({
          revisionId: 'r-change-2',
          revisionNumber: 2,
          revisionTypeName: 'เปลี่ยนแปลง',
        }),
        makeRevision({
          revisionId: 'r-edit-2',
          revisionNumber: 2,
          revisionTypeName: 'แก้ไข',
        }),
        makeRevision({
          revisionId: 'r-edit-1',
          revisionNumber: 1,
          revisionTypeName: 'แก้ไข',
        }),
        makeRevision({
          revisionId: 'r-change-1',
          revisionNumber: 1,
          revisionTypeName: 'เปลี่ยนแปลง',
        }),
      ];
      const sups = [
        makeSupplement({ supplementId: 's-2', supplementNumber: 2 }),
        makeSupplement({ supplementId: 's-1', supplementNumber: 1 }),
      ];
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: { 'plan-1': revs },
        supplementsByPlanId: { 'plan-1': sups },
      });
      const lines = result.renderedMarkdown.split('\n');
      // Expect ordering: edit-1, edit-2, change-1, change-2, sup-1, sup-2.
      expect(lines[1]).toContain('เล่มแก้ไขครั้งที่ 1');
      expect(lines[2]).toContain('เล่มแก้ไขครั้งที่ 2');
      expect(lines[3]).toContain('เล่มเปลี่ยนแปลงครั้งที่ 1');
      expect(lines[4]).toContain('เล่มเปลี่ยนแปลงครั้งที่ 2');
      expect(lines[5]).toContain('เล่มเพิ่มเติมครั้งที่ 1');
      expect(lines[6]).toContain('เล่มเพิ่มเติมครั้งที่ 2');
    });
  });

  describe('isOpen → openStateLabel translation', () => {
    it('isOpen=true → "กำลังเปิดรับ"; isOpen=false → "ปิดอยู่"', () => {
      const plan = makePlan();
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: {
          'plan-1': [
            makeRevision({ revisionNumber: 1, isOpen: true, projectCount: 0 }),
            makeRevision({ revisionNumber: 2, isOpen: false, projectCount: 0 }),
          ],
        },
        supplementsByPlanId: {},
      });
      expect(result.renderedMarkdown).toContain(
        'เล่มแก้ไขครั้งที่ 1 — กำลังเปิดรับ',
      );
      expect(result.renderedMarkdown).toContain(
        'เล่มแก้ไขครั้งที่ 2 — ปิดอยู่',
      );
    });
  });

  describe('belt-and-braces — no negative-space leakage', () => {
    it('never emits any "ไม่มี…" string regardless of bucket emptiness', () => {
      const plan = makePlan({
        planActivityStatus: {
          freshness: 'latest',
          freshnessLabel: 'เล่มล่าสุด',
          activities: [{ key: 'none', label: 'ไม่มีกิจกรรมเปิด' }],
        },
      });
      const result = composePlanCatalogMarkdown({
        plans: [plan],
        revisionsByPlanId: { 'plan-1': [] },
        supplementsByPlanId: { 'plan-1': [] },
      });
      expect(result.renderedMarkdown).not.toMatch(/ไม่มี/);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Wave AI-EXEC-CHAT-BOOK-ANSWER-QUALITY — BE-ORCH-01 (D1/B1/B2/R4)
// ──────────────────────────────────────────────────────────────────────

describe('BE-ORCH-01 / composePlanCatalogSummaryLine (D1 4-type taxonomy)', () => {
  it('returns empty string for zero plans', () => {
    expect(
      composePlanCatalogSummaryLine({
        plans: [],
        revisionsByPlanId: {},
        supplementsByPlanId: {},
      }),
    ).toBe('');
  });

  it('counts เล่มหลัก + เล่มแก้ไข + เล่มเปลี่ยนแปลง separately (never collapsed)', () => {
    const plan = makePlan();
    const line = composePlanCatalogSummaryLine({
      plans: [plan],
      revisionsByPlanId: {
        'plan-1': [
          makeRevision({ revisionId: 'r1', revisionTypeName: 'แก้ไข' }),
          makeRevision({ revisionId: 'r2', revisionTypeName: 'เปลี่ยนแปลง' }),
        ],
      },
      supplementsByPlanId: {},
    });
    // 1 main + 1 edit + 1 change = 3; supplement omitted (zero → silence).
    expect(line).toBe(
      'ตอนนี้มีเล่มแผนทั้งหมด 3 เล่ม (เล่มหลัก 1 · เล่มแก้ไข 1 · เล่มเปลี่ยนแปลง 1)',
    );
    expect(line).not.toContain('เล่มเพิ่มเติม');
  });

  it('includes เล่มเพิ่มเติม when supplements present', () => {
    const line = composePlanCatalogSummaryLine({
      plans: [makePlan()],
      revisionsByPlanId: {},
      supplementsByPlanId: { 'plan-1': [makeSupplement()] },
    });
    expect(line).toBe(
      'ตอนนี้มีเล่มแผนทั้งหมด 2 เล่ม (เล่มหลัก 1 · เล่มเพิ่มเติม 1)',
    );
  });
});

describe('BE-ORCH-01 / equipment segment in bullets + header (B2)', () => {
  it('appends "· ครุภัณฑ์ N รายการ" to a revision bullet when count > 0', () => {
    const result = composePlanCatalogMarkdown({
      plans: [makePlan()],
      revisionsByPlanId: {
        'plan-1': [
          makeRevision({
            revisionNumber: 1,
            revisionTypeName: 'แก้ไข',
            isOpen: true,
            projectCount: 2,
            equipmentCount: 3,
          }),
        ],
      },
      supplementsByPlanId: {},
    });
    expect(result.renderedMarkdown).toContain(
      '- เล่มแก้ไขครั้งที่ 1 — กำลังเปิดรับ · มีโครงการ 2 โครงการ · ครุภัณฑ์ 3 รายการ',
    );
  });

  it('omits the equipment segment at zero/undefined (silence — byte-identical to legacy)', () => {
    const withZero = composePlanCatalogMarkdown({
      plans: [makePlan()],
      revisionsByPlanId: {
        'plan-1': [makeRevision({ projectCount: 1, equipmentCount: 0 })],
      },
      supplementsByPlanId: {},
    });
    expect(withZero.renderedMarkdown).not.toContain('ครุภัณฑ์');
    expect(withZero.renderedMarkdown).toBe(
      '**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด\n' +
        '- เล่มแก้ไขครั้งที่ 1 — ปิดอยู่ · มีโครงการ 1 โครงการ',
    );
  });

  it('appends main-book equipment to the plan header when count > 0', () => {
    const result = composePlanCatalogMarkdown({
      plans: [
        makePlan({
          equipmentCount: 5,
          planActivityStatus: {
            freshness: 'latest',
            freshnessLabel: 'เล่มล่าสุด',
            activities: [],
          },
        }),
      ],
      revisionsByPlanId: {},
      supplementsByPlanId: {},
    });
    expect(result.renderedMarkdown).toBe(
      '**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด · ครุภัณฑ์ 5 รายการ',
    );
  });

  // B3 (2026-07-18) — main-book PROJECT count (document-level) on the header.
  it('appends main-book project segment to the plan header when count > 0 (before equipment)', () => {
    const result = composePlanCatalogMarkdown({
      plans: [
        makePlan({
          projectCount: 3,
          equipmentCount: 3,
          planActivityStatus: {
            freshness: 'latest',
            freshnessLabel: 'เล่มล่าสุด',
            activities: [],
          },
        }),
      ],
      revisionsByPlanId: {},
      supplementsByPlanId: {},
    });
    // Project segment first, then equipment — mirrors the sub-book bullets.
    expect(result.renderedMarkdown).toBe(
      '**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด · มีโครงการ 3 โครงการ · ครุภัณฑ์ 3 รายการ',
    );
  });

  it('omits the main-book project segment at zero/undefined (silence)', () => {
    const result = composePlanCatalogMarkdown({
      plans: [
        makePlan({
          projectCount: 0,
          planActivityStatus: {
            freshness: 'latest',
            freshnessLabel: 'เล่มล่าสุด',
            activities: [],
          },
        }),
      ],
      revisionsByPlanId: {},
      supplementsByPlanId: {},
    });
    expect(result.renderedMarkdown).not.toContain('มีโครงการ');
    expect(result.renderedMarkdown).toBe(
      '**แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570** — เล่มล่าสุด',
    );
  });
});

// Wave AI-EXEC-CHAT-LIVE-QA-5BUG (BUG3) — the plan catalog must render the
// DPR/DPS-description round label (verbatim `roundLabel`) so labels read
// IDENTICALLY to head-roster / timeline #59, NOT the legacy `revisionNumber`
// global-sequence label ("เล่มเปลี่ยนแปลงครั้งที่ 2").
describe('BUG3 / revision + supplement bullets prefer roundLabel', () => {
  it('uses roundLabel verbatim when present (change round shows its own per-type number + year)', () => {
    const result = composePlanCatalogMarkdown({
      plans: [makePlan()],
      revisionsByPlanId: {
        'plan-1': [
          makeRevision({
            revisionId: 'rev-edit',
            revisionNumber: 1,
            revisionTypeName: 'แก้ไข',
            roundLabel: 'แก้ไข ครั้งที่ 1/2569',
            isOpen: false,
            projectCount: 1,
          }),
          makeRevision({
            revisionId: 'rev-change',
            // revisionNumber is the GLOBAL sequence (change = 2) — the bug.
            revisionNumber: 2,
            revisionTypeName: 'เปลี่ยนแปลง',
            roundLabel: 'เปลี่ยนแปลง ครั้งที่ 1/2569',
            isOpen: false,
            projectCount: 1,
          }),
        ],
      },
      supplementsByPlanId: {},
    });
    // Verbatim roundLabel — NOT "เล่มเปลี่ยนแปลงครั้งที่ 2".
    expect(result.renderedMarkdown).toContain('- เปลี่ยนแปลง ครั้งที่ 1/2569 —');
    expect(result.renderedMarkdown).toContain('- แก้ไข ครั้งที่ 1/2569 —');
    expect(result.renderedMarkdown).not.toContain('เล่มเปลี่ยนแปลงครั้งที่ 2');
  });

  it('falls back to the composed label when roundLabel is absent (orphan/legacy)', () => {
    const result = composePlanCatalogMarkdown({
      plans: [makePlan()],
      revisionsByPlanId: {
        'plan-1': [
          makeRevision({
            revisionNumber: 1,
            revisionTypeName: 'แก้ไข',
            isOpen: false,
            projectCount: 1,
          }),
        ],
      },
      supplementsByPlanId: {},
    });
    expect(result.renderedMarkdown).toContain('- เล่มแก้ไขครั้งที่ 1 —');
  });
});

describe('BE-ORCH-01 / applyEquipmentCounts (merge + orphan R4)', () => {
  function makeCounts(
    overrides: Partial<EquipmentChildBookCounts> = {},
  ): EquipmentChildBookCounts {
    return {
      main: overrides.main ?? { itemCount: 0 },
      byRevision: overrides.byRevision ?? [],
      bySupplement: overrides.bySupplement ?? [],
      unresolvedCount: overrides.unresolvedCount ?? 0,
    };
  }

  it('null counts → entries unchanged, mainEquipmentCount 0 (degrade path)', () => {
    const revs = [makeRevision({ revisionId: 'r1' })];
    const sups = [makeSupplement({ supplementId: 's1' })];
    const out = applyEquipmentCounts(revs, sups, null);
    expect(out.revisions).toBe(revs);
    expect(out.supplements).toBe(sups);
    expect(out.mainEquipmentCount).toBe(0);
  });

  it('matches equipment counts onto existing entries by id', () => {
    const out = applyEquipmentCounts(
      [makeRevision({ revisionId: 'r1', revisionTypeName: 'แก้ไข' })],
      [makeSupplement({ supplementId: 's1' })],
      makeCounts({
        main: { itemCount: 4 },
        byRevision: [
          {
            revisionId: 'r1',
            revisionNumber: 1,
            revisionTypeName: 'แก้ไข',
            itemCount: 2,
          },
        ],
        bySupplement: [
          { supplementId: 's1', supplementNumber: 1, itemCount: 7 },
        ],
      }),
    );
    expect(out.revisions[0].equipmentCount).toBe(2);
    expect(out.supplements[0].equipmentCount).toBe(7);
    expect(out.mainEquipmentCount).toBe(4);
  });

  it('appends an orphan revision entry for an equipment-only round (R4)', () => {
    const out = applyEquipmentCounts(
      [], // no project-side revision entries
      [],
      makeCounts({
        byRevision: [
          {
            revisionId: 'orphan-1',
            revisionNumber: 2,
            revisionTypeName: 'เปลี่ยนแปลง',
            itemCount: 1,
          },
        ],
      }),
    );
    expect(out.revisions).toHaveLength(1);
    expect(out.revisions[0]).toMatchObject({
      revisionId: 'orphan-1',
      revisionNumber: 2,
      revisionTypeName: 'เปลี่ยนแปลง',
      projectCount: 0,
      equipmentCount: 1,
    });
  });

  it('appends an orphan supplement entry for an equipment-only round (R4)', () => {
    const out = applyEquipmentCounts(
      [],
      [],
      makeCounts({
        bySupplement: [
          { supplementId: 'orphan-s', supplementNumber: 3, itemCount: 6 },
        ],
      }),
    );
    expect(out.supplements).toHaveLength(1);
    expect(out.supplements[0]).toMatchObject({
      supplementId: 'orphan-s',
      supplementNumber: 3,
      projectCount: 0,
      equipmentCount: 6,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Telemetry hook test
// ──────────────────────────────────────────────────────────────────────

describe('BE-01 / emitTelemetry', () => {
  it('logs with the stable PLAN_CATALOG_TELEMETRY_LABEL prefix', () => {
    const calls: Array<{ message: string }> = [];
    const mockLogger = {
      log: (message: unknown) => {
        calls.push({ message: String(message) });
      },
    } as unknown as Logger;

    emitTelemetry(
      {
        timestamp: '2026-05-29T00:00:00.000Z',
        userId: 'user-x',
        totalPlans: 3,
        expandedPlans: 1,
        deferredPlans: 2,
        renderedMarkdownByteLength: 256,
        fanOutLatencyMs: 42,
      },
      mockLogger,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain(PLAN_CATALOG_TELEMETRY_LABEL);
    expect(calls[0].message).toContain(
      'ai-executive-chat-telemetry:plan-catalog-overview',
    );
    // Payload fields are serialized.
    expect(calls[0].message).toContain('"userId":"user-x"');
    expect(calls[0].message).toContain('"totalPlans":3');
    expect(calls[0].message).toContain('"expandedPlans":1');
    expect(calls[0].message).toContain('"deferredPlans":2');
    expect(calls[0].message).toContain('"renderedMarkdownByteLength":256');
    expect(calls[0].message).toContain('"fanOutLatencyMs":42');
  });
});
