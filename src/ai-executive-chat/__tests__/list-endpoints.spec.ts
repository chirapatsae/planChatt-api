/**
 * BE-W46-01 — owner-scoped GET /conversations + GET /:id/messages.
 *
 * Exercises the two new public methods on `AiExecutiveChatService`:
 *
 *   - `listConversationsForOwner(workHistoryId)`
 *   - `listMessagesForConversation(conversationId, workHistoryId)`
 *
 * Both replace Wave 44 stubs that unconditionally returned empty
 * envelopes (see `docs/reports/wave46/WAVE46_CHAT_UX_BUG_RCA.md`).
 *
 * Contract under test:
 *   - §4 ownership via `workHistoryId` (NOT `userId`).
 *   - §17.2 advisory — reads never gate workflow.
 *   - §17.3 queries stay inside `ai_*`; no project-table JOIN.
 *   - §17.4 `isStale: false` forced on every message row.
 *   - §17.11 no role exemption — cross-owner reads surface as 404 on
 *     the messages endpoint (enumeration guard), empty list on the
 *     conversations endpoint (owner-scoped by construction).
 *
 * The service is instantiated with stubbed repositories; the TypeORM
 * query builder is intercepted via a chainable fluent mock that
 * returns configured payloads on `.getMany()` / `.getRawMany()`.
 */
import { NotFoundException } from '@nestjs/common';
import { AiExecutiveChatService } from '../ai-executive-chat.service';
import { AiExecutiveConversation } from '../entities/ai-executive-conversation.entity';
import { AiExecutiveMessage } from '../entities/ai-executive-message.entity';

// ─────────────────────────────────────────────────────────────────
// Test scaffolding — chainable query-builder stub
// ─────────────────────────────────────────────────────────────────

interface QbResult {
  many?: unknown[];
  rawMany?: unknown[];
}

function makeQb(result: QbResult) {
  const qb: Record<string, jest.Mock> = {} as Record<string, jest.Mock>;
  const chain = jest.fn().mockReturnValue(qb);
  // Every chainable method returns the same qb object.
  for (const fn of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'groupBy',
    'limit',
  ]) {
    qb[fn] = chain;
  }
  qb.getMany = jest.fn().mockResolvedValue(result.many ?? []);
  qb.getRawMany = jest.fn().mockResolvedValue(result.rawMany ?? []);
  return qb;
}

function makeService(args: {
  findOne?: jest.Mock;
  conversationQbs?: QbResult[];
  messageQbs?: QbResult[];
}): AiExecutiveChatService {
  const conversationQbQueue = (args.conversationQbs ?? []).map(makeQb);
  const messageQbQueue = (args.messageQbs ?? []).map(makeQb);

  const conversationRepo = {
    findOne: args.findOne ?? jest.fn(),
    createQueryBuilder: jest.fn(() => {
      const qb = conversationQbQueue.shift();
      if (!qb) throw new Error('conversation QB pool exhausted');
      return qb;
    }),
  };
  const messageRepo = {
    createQueryBuilder: jest.fn(() => {
      const qb = messageQbQueue.shift();
      if (!qb) throw new Error('message QB pool exhausted');
      return qb;
    }),
  };

  // Minimal stubs for the constructor deps the list methods do NOT use.
  const noop = {} as unknown;

  return new AiExecutiveChatService(
    noop as never, // DataSource
    conversationRepo as never,
    messageRepo as never,
    noop as never, // WorkHistory repo
    noop as never, // LLM_CLIENT
    noop as never, // PiiRedactorService
    noop as never, // AiUsageQuotasService
    noop as never, // QuotaOrgCapService
    noop as never, // UNIFIED_PROJECT_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // BUDGET_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // STATUS_AGGREGATOR (Wave 54 BE-W54-06)
    noop as never, // GEO_ENRICHMENT (Wave 54 BE-W54-06)
    noop as never, // AGENCY_ENRICHMENT (Wave 54 BE-W54-06)
    noop as never, // RESILIENCE_ENVELOPE (Wave 54 BE-W54-07)
    noop as never, // ProjectLineageService (Wave 61)
  );
}

// ─────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────

const OWNER_WH = 'wh-owner-0001';
const OTHER_WH = 'wh-other-9999';

function conv(
  overrides: Partial<AiExecutiveConversation> = {},
): AiExecutiveConversation {
  return {
    id: overrides.id ?? 'conv-1',
    ownerWorkHistoryId: overrides.ownerWorkHistoryId ?? OWNER_WH,
    title: overrides.title ?? 'บทสนทนาทดสอบ',
    model: overrides.model ?? 'gpt-4o',
    createdAt: overrides.createdAt ?? new Date('2026-04-20T10:00:00Z'),
    updatedAt:
      overrides.updatedAt === undefined
        ? new Date('2026-04-22T10:00:00Z')
        : overrides.updatedAt,
    deletedAt: overrides.deletedAt ?? null,
    // Wave 51 BE-W51-01 — DB-level default is `'default-placeholder'`;
    // tests override as needed.
    titleSource: overrides.titleSource ?? 'default-placeholder',
    titleGeneratedAt:
      overrides.titleGeneratedAt === undefined
        ? null
        : overrides.titleGeneratedAt,
    messages: [],
  } as AiExecutiveConversation;
}

function msg(
  overrides: Partial<AiExecutiveMessage> = {},
): AiExecutiveMessage {
  const base: Partial<AiExecutiveMessage> = {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    contentText: 'hello',
    toolName: null,
    toolCallsJson: null,
    toolResultJson: null,
    tokensIn: null,
    tokensOut: null,
    model: 'gpt-4o',
    createdAt: new Date('2026-04-22T10:00:00Z'),
    // Wave 50 BE-W50-01 — fixture default; overrides can bump per-row.
    turnIndex: 0,
  };
  return { ...base, ...overrides } as AiExecutiveMessage;
}

// ─────────────────────────────────────────────────────────────────
// listConversationsForOwner
// ─────────────────────────────────────────────────────────────────

describe('BE-W46-01 / listConversationsForOwner', () => {
  it('returns an empty array when the owner has no conversations', async () => {
    const svc = makeService({
      conversationQbs: [{ many: [] }],
      messageQbs: [], // no follow-up calls
    });
    const out = await svc.listConversationsForOwner(OWNER_WH);
    expect(out).toEqual([]);
  });

  it('returns populated summaries with preview + count', async () => {
    const c1 = conv({ id: 'c1', title: 'A' });
    const c2 = conv({ id: 'c2', title: 'B' });
    const svc = makeService({
      conversationQbs: [{ many: [c1, c2] }],
      messageQbs: [
        {
          rawMany: [
            { conversationId: 'c1', n: 3 },
            { conversationId: 'c2', n: 1 },
          ],
        },
        {
          rawMany: [
            { conversationId: 'c1', contentText: 'สวัสดีครับ' },
            { conversationId: 'c2', contentText: null },
          ],
        },
      ],
    });
    const out = await svc.listConversationsForOwner(OWNER_WH);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'c1',
      title: 'A',
      messageCount: 3,
      lastMessagePreview: 'สวัสดีครับ',
    });
    expect(out[1]).toMatchObject({
      id: 'c2',
      title: 'B',
      messageCount: 1,
      lastMessagePreview: null,
    });
  });

  it('returns null preview and zero count for an empty conversation', async () => {
    const c1 = conv({ id: 'c-empty' });
    const svc = makeService({
      conversationQbs: [{ many: [c1] }],
      messageQbs: [
        { rawMany: [] }, // no counts
        { rawMany: [] }, // no previews
      ],
    });
    const out = await svc.listConversationsForOwner(OWNER_WH);
    expect(out[0].lastMessagePreview).toBeNull();
    expect(out[0].messageCount).toBe(0);
  });

  it('truncates previews longer than 120 chars with ellipsis', async () => {
    const long = 'ก'.repeat(200);
    const c1 = conv({ id: 'c1' });
    const svc = makeService({
      conversationQbs: [{ many: [c1] }],
      messageQbs: [
        { rawMany: [{ conversationId: 'c1', n: 1 }] },
        { rawMany: [{ conversationId: 'c1', contentText: long }] },
      ],
    });
    const out = await svc.listConversationsForOwner(OWNER_WH);
    // 120 chars + ellipsis
    expect(out[0].lastMessagePreview?.endsWith('…')).toBe(true);
    expect(out[0].lastMessagePreview?.length).toBe(121);
  });

  // ─────────────────────────────────────────────────────────────
  // Wave 51 BE-W51-01 — titleSource + titleGeneratedAt projection.
  //
  // Asserts that `listConversationsForOwner` carries both new fields
  // through verbatim from the entity. §12 / §17.3 compliance is covered
  // structurally: the test never touches `tracking_status` and reads
  // ONLY the `ai_*`-scoped entity.
  // ─────────────────────────────────────────────────────────────
  it('projects titleSource + titleGeneratedAt from the entity onto every DTO', async () => {
    const gen = new Date('2026-04-23T12:34:56Z');
    const placeholderRow = conv({
      id: 'c-default',
      title: 'บทสนทนาใหม่',
      titleSource: 'default-placeholder',
      titleGeneratedAt: null,
    });
    const autoRow = conv({
      id: 'c-auto',
      title: 'สรุปงบโครงการเขตเมือง',
      titleSource: 'llm-auto',
      titleGeneratedAt: gen,
    });
    const renamedRow = conv({
      id: 'c-manual',
      title: 'ชื่อที่ผู้ใช้ตั้งเอง',
      titleSource: 'user-rename',
      titleGeneratedAt: gen,
    });
    const svc = makeService({
      conversationQbs: [{ many: [placeholderRow, autoRow, renamedRow] }],
      messageQbs: [
        { rawMany: [] }, // counts
        { rawMany: [] }, // previews
      ],
    });
    const out = await svc.listConversationsForOwner(OWNER_WH);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: 'c-default',
      titleSource: 'default-placeholder',
      titleGeneratedAt: null,
    });
    expect(out[1]).toMatchObject({
      id: 'c-auto',
      titleSource: 'llm-auto',
      titleGeneratedAt: gen.toISOString(),
    });
    expect(out[2]).toMatchObject({
      id: 'c-manual',
      titleSource: 'user-rename',
      titleGeneratedAt: gen.toISOString(),
    });
    // Belt-and-braces: every row must have the field present as a
    // member of the required enum domain.
    expect(
      out.every((row) =>
        ['default-placeholder', 'llm-auto', 'user-rename'].includes(
          row.titleSource,
        ),
      ),
    ).toBe(true);
  });

  it('applies the owner_work_history_id + deleted_at IS NULL filter and LIMIT 200', async () => {
    // Capture the actual WHERE / limit calls via a spy on the qb chain.
    let whereCall: { sql: string; params: Record<string, unknown> } | null = null;
    let limitVal: number | null = null;
    let deletedClause = false;
    let orderClause: string | null = null;

    const chainable: Record<string, jest.Mock> = {};
    const chain = jest.fn().mockReturnValue(chainable);
    chainable.where = jest.fn((sql: string, params: Record<string, unknown>) => {
      whereCall = { sql, params };
      return chainable;
    });
    chainable.andWhere = jest.fn((sql: string) => {
      if (sql.includes('deleted_at IS NULL')) deletedClause = true;
      return chainable;
    });
    chainable.orderBy = jest.fn((col: string) => {
      orderClause = col;
      return chainable;
    });
    chainable.addOrderBy = chain;
    chainable.limit = jest.fn((n: number) => {
      limitVal = n;
      return chainable;
    });
    chainable.getMany = jest.fn().mockResolvedValue([]);

    const conversationRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => chainable),
    };
    const messageRepo = {
      createQueryBuilder: jest.fn(),
    };

    const svc = new AiExecutiveChatService(
      {} as never,
      conversationRepo as never,
      messageRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never, // UNIFIED_PROJECT_AGGREGATOR (Wave 54 BE-W54-06)
      {} as never, // BUDGET_AGGREGATOR (Wave 54 BE-W54-06)
      {} as never, // STATUS_AGGREGATOR (Wave 54 BE-W54-06)
      {} as never, // GEO_ENRICHMENT (Wave 54 BE-W54-06)
      {} as never, // AGENCY_ENRICHMENT (Wave 54 BE-W54-06)
      {} as never, // RESILIENCE_ENVELOPE (Wave 54 BE-W54-07)
      {} as never, // ProjectLineageService (Wave 61)
    );
    await svc.listConversationsForOwner(OWNER_WH);

    expect(whereCall).not.toBeNull();
    expect(whereCall!.sql).toContain('owner_work_history_id');
    expect(whereCall!.params).toEqual({ whId: OWNER_WH });
    expect(deletedClause).toBe(true);
    expect(limitVal).toBe(200);
    expect(orderClause).toContain('updated_at');
  });
});

// ─────────────────────────────────────────────────────────────────
// listMessagesForConversation
// ─────────────────────────────────────────────────────────────────

describe('BE-W46-01 / listMessagesForConversation', () => {
  it('throws 404 CONVERSATION_NOT_FOUND when the conversation does not exist', async () => {
    const svc = makeService({ findOne: jest.fn().mockResolvedValue(null) });
    await expect(
      svc.listMessagesForConversation('missing-id', OWNER_WH),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 CONVERSATION_NOT_FOUND when the caller is not the owner (enumeration guard)', async () => {
    const svc = makeService({
      findOne: jest.fn().mockResolvedValue(conv({ ownerWorkHistoryId: OTHER_WH })),
    });
    await expect(
      svc.listMessagesForConversation('conv-1', OWNER_WH),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns messages in chronological order with isStale:false forced', async () => {
    const earlier = msg({
      id: 'm1',
      createdAt: new Date('2026-04-22T09:00:00Z'),
      role: 'user',
      contentText: 'first',
      turnIndex: 0,
    });
    const later = msg({
      id: 'm2',
      createdAt: new Date('2026-04-22T09:00:05Z'),
      role: 'assistant',
      contentText: 'second',
      turnIndex: 1,
    });
    const svc = makeService({
      findOne: jest.fn().mockResolvedValue(conv()),
      messageQbs: [{ many: [earlier, later] }],
    });
    const out = await svc.listMessagesForConversation('conv-1', OWNER_WH);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('m1');
    expect(out[1].id).toBe('m2');
    expect(out.every((m) => m.isStale === false)).toBe(true);
    // ISO-string serialization
    expect(out[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes tool-role rows (FE MessageBubble renders tool traces)', async () => {
    const toolRow = msg({
      id: 'm-tool',
      role: 'tool',
      contentText: null,
      toolName: 'listActivePlans',
      toolResultJson: { items: [] },
    });
    const svc = makeService({
      findOne: jest.fn().mockResolvedValue(conv()),
      messageQbs: [{ many: [toolRow] }],
    });
    const out = await svc.listMessagesForConversation('conv-1', OWNER_WH);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('tool');
    expect(out[0].toolName).toBe('listActivePlans');
    expect(out[0].toolResultJson).toEqual({ items: [] });
    expect(out[0].isStale).toBe(false);
  });

  it('applies deleted_at IS NULL filter and LIMIT 500 on message query', async () => {
    let deletedClause = false;
    let limitVal: number | null = null;
    let orderMain: string | null = null;

    const chainable: Record<string, jest.Mock> = {};
    const chain = jest.fn().mockReturnValue(chainable);
    chainable.where = chain;
    chainable.andWhere = jest.fn((sql: string) => {
      if (sql.includes('deleted_at IS NULL')) deletedClause = true;
      return chainable;
    });
    chainable.orderBy = jest.fn((col: string) => {
      orderMain = col;
      return chainable;
    });
    chainable.addOrderBy = chain;
    chainable.limit = jest.fn((n: number) => {
      limitVal = n;
      return chainable;
    });
    chainable.getMany = jest.fn().mockResolvedValue([]);

    const conversationRepo = {
      findOne: jest.fn().mockResolvedValue(conv()),
      createQueryBuilder: jest.fn(),
    };
    const messageRepo = {
      createQueryBuilder: jest.fn(() => chainable),
    };

    const svc = new AiExecutiveChatService(
      {} as never,
      conversationRepo as never,
      messageRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never, // UNIFIED_PROJECT_AGGREGATOR (Wave 54 BE-W54-06)
      {} as never, // BUDGET_AGGREGATOR (Wave 54 BE-W54-06)
      {} as never, // STATUS_AGGREGATOR (Wave 54 BE-W54-06)
      {} as never, // GEO_ENRICHMENT (Wave 54 BE-W54-06)
      {} as never, // AGENCY_ENRICHMENT (Wave 54 BE-W54-06)
      {} as never, // RESILIENCE_ENVELOPE (Wave 54 BE-W54-07)
      {} as never, // ProjectLineageService (Wave 61)
    );
    await svc.listMessagesForConversation('conv-1', OWNER_WH);

    expect(deletedClause).toBe(true);
    expect(limitVal).toBe(500);
    // Wave 50 BE-W50-01 — primary sort is now `turn_index ASC`. The
    // Wave 48 `created_at` fallback remains populated on every row but
    // is no longer the ORDER BY driver. See RCA §2.1 G2.
    expect(orderMain).toContain('turn_index');
  });
});
