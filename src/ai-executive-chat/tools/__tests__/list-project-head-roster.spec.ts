/**
 * Wave AI-EXEC-CHAT-HEAD-BOOK-ROSTER-AND-VERBOSE-OMIT (rework) —
 * `listProjectHeadRoster` registry + handler coverage.
 *
 * Covers:
 *   - registry: tool present, whitelisted, planId required, originScope enum
 *   - §17.11 role guard
 *   - handler-owned UUID validation → friendly-hint envelope (never throw)
 *   - deps-absent graceful envelope
 *   - happy path: delegates to ProjectLineageService.listHeadRoster and maps
 *     headStatusName → headStatusTh; passes originScope through
 */
import {
  EXECUTIVE_TOOL_REGISTRY,
  EXECUTIVE_TOOL_NAMES,
} from '../tool-registry';
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import type {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import { validateAgainstSchema } from '../tool-schema-validator';

const PLAN_A = '11111111-1111-4111-8111-111111111111';

const CTX: ExecutiveCallerContext = {
  userId: 'user-1',
  workHistoryId: 'wh-1',
  roleName: 'c-level',
  workStatusName: 'approved',
};

function makeDeps(listHeadRoster: jest.Mock): ExecutiveToolHandlerDeps {
  return {
    projectLineage: { listHeadRoster } as never,
  } as unknown as ExecutiveToolHandlerDeps;
}

const ROSTER = [
  {
    originProjectId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    projectTitle: 'โครงการอบรมทักษะอาชีพเสริมรายได้',
    originBookType: 'main' as const,
    headProjectId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    headBookLabel: 'เล่มหลัก',
    headBookType: 'main' as const,
    headRevisionNumber: null,
    headPageNumber: 12,
    headStatusName: 'Approved',
  },
  {
    originProjectId: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    projectTitle: 'โครงการยกระดับการผลิตและพัฒนาศักยภาพการประมง',
    originBookType: 'main' as const,
    headProjectId: 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    // Wave BOOK-LABEL-DOUBLING-FIX — service now returns a self-contained
    // label (always exactly one "เล่ม" prefix); render templates emit verbatim.
    headBookLabel: 'เล่มแก้ไข ครั้งที่ 1/2569',
    headBookType: 'edit' as const,
    headRevisionNumber: 1,
    headPageNumber: 4,
    headStatusName: 'Approved',
  },
];

describe('listProjectHeadRoster', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectHeadRoster;

    it('is registered + whitelisted', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('listProjectHeadRoster');
      expect(EXECUTIVE_TOOL_NAMES).toContain('listProjectHeadRoster');
    });

    it('paramsSchema requires planId; originScope is a bounded enum', () => {
      expect(spec.paramsSchema.required).toContain('planId');
      expect(spec.paramsSchema.properties?.originScope?.enum).toEqual([
        'main',
        'revised',
        'supplement',
      ]);
      expect(spec.paramsSchema.additionalProperties).toBe(false);
    });

    it('description forbids listProjectsInPlan for these intents + read-only', () => {
      expect(spec.description).toMatch(/ห้ามใช้ listProjectsInPlan/);
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.listProjectHeadRoster;

    it('role guard: user role throws EXECUTIVE_ROLE_REQUIRED', async () => {
      await expect(
        handler(
          { planId: PLAN_A },
          { ...CTX, roleName: 'user' },
          makeDeps(jest.fn()),
        ),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('invalid planId → friendly-hint envelope, aggregator NOT called', async () => {
      const listHeadRoster = jest.fn();
      const out = await handler(
        { planId: 'not-a-uuid' },
        CTX,
        makeDeps(listHeadRoster),
      );
      expect(out.items).toEqual([]);
      expect(typeof out.message).toBe('string');
      expect(listHeadRoster).not.toHaveBeenCalled();
    });

    it('deps absent → graceful empty envelope', async () => {
      const out = await handler(
        { planId: PLAN_A },
        CTX,
        {} as unknown as ExecutiveToolHandlerDeps,
      );
      expect(out.items).toEqual([]);
      expect(out.advisories).toEqual(['lineage-service-unavailable']);
    });

    it('happy path: maps roster + headStatusName→headStatusTh; passes originScope', async () => {
      const listHeadRoster = jest.fn().mockResolvedValue(ROSTER);
      const out = await handler(
        { planId: PLAN_A, originScope: 'main' },
        CTX,
        makeDeps(listHeadRoster),
      );
      expect(listHeadRoster).toHaveBeenCalledWith(PLAN_A, 'main');
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0].projectTitle).toBe('โครงการอบรมทักษะอาชีพเสริมรายได้');
      expect(items[0].headBookLabel).toBe('เล่มหลัก');
      expect(items[0].headPageNumber).toBe(12);
      // English status mapped to Thai display.
      expect(typeof items[0].headStatusTh).toBe('string');
      expect(items[0].headStatusTh).not.toBe('Approved');
      expect(items[1].headBookLabel).toBe('เล่มแก้ไข ครั้งที่ 1/2569');
      // Envelope validates against the tool returnSchema.
      const res = validateAgainstSchema(
        EXECUTIVE_TOOL_REGISTRY.listProjectHeadRoster.returnSchema,
        out,
      );
      expect(res.ok).toBe(true);
    });

    it('no originScope → passes undefined (whole-plan roster)', async () => {
      const listHeadRoster = jest.fn().mockResolvedValue(ROSTER);
      await handler({ planId: PLAN_A }, CTX, makeDeps(listHeadRoster));
      expect(listHeadRoster).toHaveBeenCalledWith(PLAN_A, undefined);
    });
  });
});
