/**
 * SEC-W44-01 — Attack class #8: cross-owner read / ID enumeration.
 *
 * Threat model:
 *  - Executive A authenticates and requests
 *    `GET /v1/ai/executive-chat/conversations/:id` with an `id` owned
 *    by executive B. A naive implementation returns 403 which LEAKS
 *    the existence of the row (B's conversation id can be enumerated).
 *  - Same threat applies to `DELETE /conversations/:id`, `GET /my-export`,
 *    and the admin override.
 *
 * Defense (§4 / §17.11):
 *  - Mismatched owner MUST return 404 NOT 403 (enumeration guard).
 *  - `GET /my-export` returns ONLY the caller's rows, regardless of
 *    what exists in the DB.
 *  - Admin override `DELETE /admin/conversations/:id` requires role
 *    ∈ {admin, super-admin} — enforced at service layer.
 *
 * This spec exercises the landed `AiExecutiveChatPdpaService` directly
 * with mocked repositories, so all cases are runnable today.
 */

import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AiExecutiveChatPdpaService } from '../../ai-executive-chat-pdpa.service';

type Repo = {
  findOne: jest.Mock;
  find: jest.Mock;
  softDelete: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
};

function mkRepo(): Repo {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    softDelete: jest.fn().mockResolvedValue({ affected: 0 }),
    save: jest.fn().mockResolvedValue(undefined),
    create: jest.fn((x) => x),
  } as unknown as Repo;
}

const USER_A = 'user-a';
const USER_B = 'user-b';
const WH_A = 'wh-a';
const WH_B = 'wh-b';

function mkApprovedWh(userId: string, whId: string, role: string) {
  return {
    id: whId,
    user: { id: userId },
    isCurrent: true,
    workStatus: { name: 'approved' },
    role: { name: role },
  };
}

describe('SEC-W44-01 / cross-owner-read (§4 + §17.11)', () => {
  let conversationRepo: Repo;
  let messageRepo: Repo;
  let workHistoryRepo: Repo;
  let aiUsageLogRepo: Repo;
  let service: AiExecutiveChatPdpaService;

  const CONV_OF_A = 'conv-owned-by-a';
  const CONV_OF_B = 'conv-owned-by-b';

  beforeEach(() => {
    conversationRepo = mkRepo();
    messageRepo = mkRepo();
    workHistoryRepo = mkRepo();
    aiUsageLogRepo = mkRepo();

    service = new AiExecutiveChatPdpaService(
      conversationRepo as never,
      messageRepo as never,
      workHistoryRepo as never,
      aiUsageLogRepo as never,
    );

    // WorkHistory lookup — route by userId.
    workHistoryRepo.findOne.mockImplementation(
      async (opts: { where?: { user?: { id?: string } }; relations?: string[] }) => {
        const uid = opts?.where?.user?.id;
        if (uid === USER_A) return mkApprovedWh(USER_A, WH_A, 'executive');
        if (uid === USER_B) return mkApprovedWh(USER_B, WH_B, 'executive');
        if (uid === 'admin-user') return mkApprovedWh('admin-user', 'wh-admin', 'admin');
        if (uid === 'user-user') return mkApprovedWh('user-user', 'wh-usr', 'user');
        return null;
      },
    );
  });

  describe('DELETE /conversations/:id', () => {
    it("user A deleting B's conversation returns 404 (enumeration guard, NOT 403)", async () => {
      conversationRepo.findOne.mockResolvedValueOnce({
        id: CONV_OF_B,
        ownerWorkHistoryId: WH_B,
      });
      await expect(
        service.deleteOwnConversation(CONV_OF_B, USER_A),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.deleteOwnConversation(CONV_OF_B, USER_A),
      ).rejects.toThrow('CONVERSATION_NOT_FOUND');
      // Critical: no soft delete happened.
      expect(conversationRepo.softDelete).not.toHaveBeenCalled();
      expect(messageRepo.softDelete).not.toHaveBeenCalled();
    });

    it('owner deleting own conversation succeeds', async () => {
      conversationRepo.findOne.mockResolvedValueOnce({
        id: CONV_OF_A,
        ownerWorkHistoryId: WH_A,
      });
      messageRepo.softDelete.mockResolvedValueOnce({ affected: 3 });
      const res = await service.deleteOwnConversation(CONV_OF_A, USER_A);
      expect(res).toEqual({ id: CONV_OF_A, deletedMessages: 3 });
      expect(conversationRepo.softDelete).toHaveBeenCalledWith(CONV_OF_A);
    });

    it('non-existent id returns 404', async () => {
      conversationRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.deleteOwnConversation('does-not-exist', USER_A),
      ).rejects.toThrow('CONVERSATION_NOT_FOUND');
    });
  });

  describe('GET /my-export', () => {
    it("returns ONLY the caller's conversations even if other owners exist in the DB", async () => {
      conversationRepo.find.mockResolvedValueOnce([
        {
          id: 'c1',
          ownerWorkHistoryId: WH_A,
          title: 't',
          model: 'gpt-4o',
          createdAt: new Date(),
          updatedAt: null,
          deletedAt: null,
        },
      ]);
      messageRepo.find.mockResolvedValueOnce([]);
      const exp = await service.exportOwnData(USER_A);
      // Query filter passed to find() scopes to ownerWorkHistoryId.
      expect(conversationRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ownerWorkHistoryId: WH_A }),
        }),
      );
      expect(exp.ownerWorkHistoryId).toBe(WH_A);
    });

    it('empty result returns an empty conversations array (not 404)', async () => {
      conversationRepo.find.mockResolvedValueOnce([]);
      const exp = await service.exportOwnData(USER_A);
      expect(exp.conversations).toEqual([]);
      expect(exp.ownerWorkHistoryId).toBe(WH_A);
    });
  });

  describe('DELETE /admin/conversations/:id', () => {
    it('non-admin executive hitting the admin path is REJECTED with ADMIN_ROLE_REQUIRED', async () => {
      conversationRepo.findOne.mockResolvedValueOnce({
        id: CONV_OF_A,
        ownerWorkHistoryId: WH_A,
      });
      await expect(
        service.adminDeleteConversation(CONV_OF_A, USER_A, 'policy violation'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.adminDeleteConversation(CONV_OF_A, USER_A, 'policy violation'),
      ).rejects.toThrow('ADMIN_ROLE_REQUIRED');
      expect(conversationRepo.softDelete).not.toHaveBeenCalled();
    });

    it('plain "user" role hitting admin endpoint is REJECTED', async () => {
      await expect(
        service.adminDeleteConversation(CONV_OF_A, 'user-user', 'x'),
      ).rejects.toThrow('ADMIN_ROLE_REQUIRED');
    });

    it('admin role with approved workStatus CAN delete any conversation and writes audit', async () => {
      conversationRepo.findOne.mockResolvedValueOnce({
        id: CONV_OF_B,
        ownerWorkHistoryId: WH_B,
      });
      messageRepo.softDelete.mockResolvedValueOnce({ affected: 5 });
      const res = await service.adminDeleteConversation(
        CONV_OF_B,
        'admin-user',
        'ข้อมูลเผยแพร่ผิดนโยบาย',
      );
      expect(res).toEqual({
        id: CONV_OF_B,
        ownerWorkHistoryId: WH_B,
        deletedMessages: 5,
      });
      // Audit row written to ai_usage_logs.
      expect(aiUsageLogRepo.save).toHaveBeenCalledTimes(1);
      const audit = aiUsageLogRepo.save.mock.calls[0][0];
      expect(audit.usageType).toBe('PDPA_ADMIN_DELETE');
      expect(audit.endpoint).toBe('pdpa-admin-delete');
      expect(audit.targetId).toBe(CONV_OF_B);
    });
  });

  describe.skip('E2E — pending BE-W44-02 chat surfaces', () => {
    it('GET /conversations/:id/messages returns 404 when executive A reads B\'s id', () => {
      /** BE-W44-02 replaces the empty-array stub; once implemented, this must
       *  return 404 on mismatched ownerWorkHistoryId. */
    });

    it('POST /messages with conversationId owned by another executive returns 404', () => {
      /** Per BE-W44-02 §7.1 step 2: "conversation resolve" must enforce
       *  ownerWorkHistoryId === caller.currentWorkHistory.id before
       *  appending a user turn. Mismatch → 404, not 403. */
    });
  });

  /**
   * DEFENSE NOTE:
   *  - The current `adminDeleteConversation` uses 404 semantics only
   *    for the WORKFLOW-HISTORY-NOT-FOUND case; for the role-denied
   *    case it throws 403 ForbiddenException('ADMIN_ROLE_REQUIRED').
   *    That's acceptable here because the admin surface is a separate
   *    endpoint; leaking that the admin endpoint exists does not
   *    reveal any specific conversation id.
   *  - BE-W44-02 MUST preserve 404-over-403 for the OWNER surfaces
   *    (`GET /conversations/:id/messages`, `DELETE /conversations/:id`,
   *    `POST /messages` with a foreign id).
   */
});
