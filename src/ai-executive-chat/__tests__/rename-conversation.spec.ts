/**
 * Wave 51 BE-W51-01 — `renameConversation` must set
 * `titleSource = 'user-rename'` AND populate `titleGeneratedAt` on
 * every successful manual rename.
 *
 * This value is the compare-and-set gate BE-W51-02 relies on: the
 * background auto-titler only UPDATEs rows where
 * `title_source = 'default-placeholder'`, so flipping the column to
 * `'user-rename'` here permanently opts the conversation out.
 *
 * Contract under test:
 *   - §4 ownership — non-owner returns 404 (enumeration guard).
 *   - §12 — no `tracking_status` write; rename is metadata only.
 *   - §17.3 — no FK traversal; write stays on the `ai_*`-scoped
 *     conversation row.
 *   - §17.11 — no role exemption; the enum domain is integrity.
 *
 * The test is narrow by design: it only exercises the rename path and
 * does NOT spin up the other PDPA flows (delete, export, admin-delete).
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AiExecutiveChatPdpaService } from '../ai-executive-chat-pdpa.service';
import { AiExecutiveConversation } from '../entities/ai-executive-conversation.entity';

const USER_ID = 'user-42';
const OWNER_WH = 'wh-owner-0001';
const OTHER_WH = 'wh-other-9999';

function makeConversation(
  overrides: Partial<AiExecutiveConversation> = {},
): AiExecutiveConversation {
  return {
    id: overrides.id ?? 'conv-1',
    ownerWorkHistoryId: overrides.ownerWorkHistoryId ?? OWNER_WH,
    title: overrides.title ?? 'บทสนทนาใหม่',
    model: overrides.model ?? 'gpt-4o',
    createdAt: overrides.createdAt ?? new Date('2026-04-20T10:00:00Z'),
    updatedAt:
      overrides.updatedAt === undefined
        ? new Date('2026-04-22T10:00:00Z')
        : overrides.updatedAt,
    deletedAt: overrides.deletedAt ?? null,
    titleSource: overrides.titleSource ?? 'default-placeholder',
    titleGeneratedAt:
      overrides.titleGeneratedAt === undefined
        ? null
        : overrides.titleGeneratedAt,
    messages: [],
  } as AiExecutiveConversation;
}

function makeService(args: {
  conversationFindOne?: jest.Mock;
  conversationSave?: jest.Mock;
  workHistoryFindOne?: jest.Mock;
}): {
  svc: AiExecutiveChatPdpaService;
  conversationSave: jest.Mock;
} {
  const conversationSave =
    args.conversationSave ?? jest.fn(async (row) => row);
  const conversationRepo = {
    findOne: args.conversationFindOne ?? jest.fn(),
    save: conversationSave,
    softDelete: jest.fn(),
    find: jest.fn(),
  };
  const messageRepo = {
    softDelete: jest.fn(),
    find: jest.fn(),
  };
  const workHistoryRepo = {
    findOne:
      args.workHistoryFindOne ??
      jest.fn(async () => ({
        id: OWNER_WH,
        user: { id: USER_ID },
        isCurrent: true,
        workStatus: { name: 'approved' },
        role: { name: 'user' },
      })),
  };
  const aiUsageLogRepo = {
    save: jest.fn(),
    create: jest.fn(),
  };

  const svc = new AiExecutiveChatPdpaService(
    conversationRepo as never,
    messageRepo as never,
    workHistoryRepo as never,
    aiUsageLogRepo as never,
  );
  return { svc, conversationSave };
}

describe('BE-W51-01 / renameConversation', () => {
  it('flips titleSource to "user-rename" and stamps titleGeneratedAt', async () => {
    const row = makeConversation({
      id: 'conv-abc',
      titleSource: 'default-placeholder',
      titleGeneratedAt: null,
    });
    const { svc, conversationSave } = makeService({
      conversationFindOne: jest.fn().mockResolvedValue(row),
    });

    const before = Date.now();
    const out = await svc.renameConversation(USER_ID, 'conv-abc', '  หัวข้อใหม่  ');
    const after = Date.now();

    expect(out).toEqual({ id: 'conv-abc', title: 'หัวข้อใหม่' });
    // The single save call MUST carry all three mutations on the entity.
    expect(conversationSave).toHaveBeenCalledTimes(1);
    const saved = conversationSave.mock.calls[0][0] as AiExecutiveConversation;
    expect(saved.title).toBe('หัวข้อใหม่');
    expect(saved.titleSource).toBe('user-rename');
    expect(saved.titleGeneratedAt).toBeInstanceOf(Date);
    expect(saved.titleGeneratedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved.titleGeneratedAt!.getTime()).toBeLessThanOrEqual(after);
  });

  it('upgrades titleSource from "llm-auto" to "user-rename" on manual override', async () => {
    const row = makeConversation({
      id: 'conv-auto',
      title: 'สรุปงบโครงการ',
      titleSource: 'llm-auto',
      titleGeneratedAt: new Date('2026-04-23T00:00:00Z'),
    });
    const { svc, conversationSave } = makeService({
      conversationFindOne: jest.fn().mockResolvedValue(row),
    });

    await svc.renameConversation(USER_ID, 'conv-auto', 'ชื่อที่ผู้ใช้ตั้งเอง');
    const saved = conversationSave.mock.calls[0][0] as AiExecutiveConversation;
    expect(saved.titleSource).toBe('user-rename');
    expect(saved.titleGeneratedAt).toBeInstanceOf(Date);
    // Must have advanced past the previous llm-auto stamp.
    expect(saved.titleGeneratedAt!.getTime()).toBeGreaterThan(
      new Date('2026-04-23T00:00:00Z').getTime(),
    );
  });

  it('returns 404 when the conversation does not exist', async () => {
    const { svc } = makeService({
      conversationFindOne: jest.fn().mockResolvedValue(null),
    });
    await expect(
      svc.renameConversation(USER_ID, 'missing', 'ชื่อใหม่'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the caller is not the owner (enumeration guard)', async () => {
    const row = makeConversation({ ownerWorkHistoryId: OTHER_WH });
    const { svc, conversationSave } = makeService({
      conversationFindOne: jest.fn().mockResolvedValue(row),
    });
    await expect(
      svc.renameConversation(USER_ID, 'conv-1', 'ชื่อใหม่'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(conversationSave).not.toHaveBeenCalled();
  });

  it('rejects an empty title with 400 TITLE_REQUIRED', async () => {
    const { svc, conversationSave } = makeService({
      conversationFindOne: jest.fn(),
    });
    await expect(
      svc.renameConversation(USER_ID, 'conv-1', '   '),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(conversationSave).not.toHaveBeenCalled();
  });

  it('rejects when caller workStatus != approved (§4 / §17.11 integrity)', async () => {
    const { svc, conversationSave } = makeService({
      workHistoryFindOne: jest.fn(async () => ({
        id: OWNER_WH,
        user: { id: USER_ID },
        isCurrent: true,
        workStatus: { name: 'pending' },
        role: { name: 'user' },
      })),
    });
    await expect(
      svc.renameConversation(USER_ID, 'conv-1', 'ชื่อใหม่'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(conversationSave).not.toHaveBeenCalled();
  });
});
