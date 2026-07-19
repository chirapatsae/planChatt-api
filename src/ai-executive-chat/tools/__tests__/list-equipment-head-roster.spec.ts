/**
 * Wave AI-EXEC-CHAT-EQUIPMENT-HEAD-ROSTER — `listEquipmentHeadRoster`
 * registry + handler coverage (ผ.03 analog of listProjectHeadRoster).
 *
 * Covers:
 *   - registry: tool present, whitelisted, planId required, originScope enum
 *   - §17.11 role guard
 *   - handler-owned UUID validation → friendly-hint envelope (never throw)
 *   - deps-absent graceful envelope
 *   - happy path: delegates to aggregator.headRoster; passes originScope;
 *     envelope validates against returnSchema
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

function makeDeps(headRoster: jest.Mock): ExecutiveToolHandlerDeps {
  return {
    unifiedEquipment: { headRoster } as never,
  } as unknown as ExecutiveToolHandlerDeps;
}

const ROSTER = [
  {
    equipmentName: 'เครื่องปรับอากาศ แบบแยกส่วน',
    categoryName: 'ครุภัณฑ์สำนักงาน',
    originBookType: 'main' as const,
    headBookLabel: 'เล่มหลัก',
    headBookType: 'main' as const,
    headRevisionNumber: null,
    headPageNumber: 21,
    headStatusTh: 'อนุมัติ',
  },
  {
    equipmentName: 'ประเภทครุภัณฑ์ 14. ครุภัณฑ์คอมพิวเตอร์',
    categoryName: 'ครุภัณฑ์คอมพิวเตอร์',
    originBookType: 'main' as const,
    // Wave BOOK-LABEL-DOUBLING-FIX — self-contained label (one "เล่ม" prefix).
    headBookLabel: 'เล่มเปลี่ยนแปลง ครั้งที่ 1/2569',
    headBookType: 'change' as const,
    headRevisionNumber: 1,
    headPageNumber: 9,
    headStatusTh: 'อนุมัติ',
  },
];

describe('listEquipmentHeadRoster', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listEquipmentHeadRoster;

    it('is registered + whitelisted', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('listEquipmentHeadRoster');
      expect(EXECUTIVE_TOOL_NAMES).toContain('listEquipmentHeadRoster');
    });

    it('paramsSchema requires planId; originScope bounded enum', () => {
      expect(spec.paramsSchema.required).toContain('planId');
      expect(spec.paramsSchema.properties?.originScope?.enum).toEqual([
        'main',
        'revised',
        'supplement',
      ]);
      expect(spec.paramsSchema.additionalProperties).toBe(false);
    });

    it('description forbids listEquipmentInPlan for the head-roster intent', () => {
      expect(spec.description).toMatch(/ห้ามใช้ listEquipmentInPlan/);
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.listEquipmentHeadRoster;

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
      const headRoster = jest.fn();
      const out = await handler(
        { planId: 'not-a-uuid' },
        CTX,
        makeDeps(headRoster),
      );
      expect(out.items).toEqual([]);
      expect(typeof out.message).toBe('string');
      expect(headRoster).not.toHaveBeenCalled();
    });

    it('deps absent → graceful empty envelope', async () => {
      const out = await handler(
        { planId: PLAN_A },
        CTX,
        {} as unknown as ExecutiveToolHandlerDeps,
      );
      expect(out.items).toEqual([]);
      expect(typeof out.message).toBe('string');
    });

    it('happy path: maps roster; passes originScope; validates against returnSchema', async () => {
      const headRoster = jest.fn().mockResolvedValue(ROSTER);
      const out = await handler(
        { planId: PLAN_A, originScope: 'main' },
        CTX,
        makeDeps(headRoster),
      );
      expect(headRoster).toHaveBeenCalledWith(PLAN_A, 'main');
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0].equipmentName).toBe('เครื่องปรับอากาศ แบบแยกส่วน');
      expect(items[0].headBookLabel).toBe('เล่มหลัก');
      expect(items[0].headPageNumber).toBe(21);
      // Label consistent with the project roster + self-contained "เล่ม" prefix.
      expect(items[1].headBookLabel).toBe('เล่มเปลี่ยนแปลง ครั้งที่ 1/2569');
      const res = validateAgainstSchema(
        EXECUTIVE_TOOL_REGISTRY.listEquipmentHeadRoster.returnSchema,
        out,
      );
      expect(res.ok).toBe(true);
    });

    it('no originScope → passes undefined (whole-plan roster)', async () => {
      const headRoster = jest.fn().mockResolvedValue(ROSTER);
      await handler({ planId: PLAN_A }, CTX, makeDeps(headRoster));
      expect(headRoster).toHaveBeenCalledWith(PLAN_A, undefined);
    });
  });
});
