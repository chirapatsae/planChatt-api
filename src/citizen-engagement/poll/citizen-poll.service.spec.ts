import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CitizenPollService } from './citizen-poll.service';
import { CreateCitizenPollDto } from '../dto/create-citizen-poll.dto';

/**
 * Unit spec for CitizenPollService (W-S7).
 *
 * The service does NOT hash anything (no encryption.util import), so — like the
 * post / bookmark specs — there is NO jest.mock('src/util/encryption.util'). We
 * mock the constructor repos + a dataSource whose `.transaction(cb)` invokes the
 * callback with a mock EntityManager that hands back per-entity sub-repos.
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  softDelete: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'generated-id', ...x })),
    find: jest.fn(async () => []),
    findOne: jest.fn(),
    softDelete: jest.fn(async () => undefined),
    createQueryBuilder: jest.fn(),
  };
}

/** Chainable insert builder stub for `.insert().values().orIgnore().execute()`. */
function makeInsertBuilder() {
  const b: Record<string, jest.Mock> & { _values: unknown[] } = {
    _values: [],
  } as never;
  b.insert = jest.fn(() => b);
  b.values = jest.fn((v: unknown) => {
    b._values.push(v);
    return b;
  });
  b.orIgnore = jest.fn(() => b);
  b.execute = jest.fn(async () => ({ identifiers: [] }));
  return b;
}

/**
 * Chainable grouped-SELECT builder for the per-option recount
 * `.select().addSelect().where().andWhere().groupBy().getRawMany()`.
 * `rawRows` are the `{ optionId, count }` rows the query "returns".
 */
function makeRecountBuilder(
  rawRows: Array<{ optionId: string; count: string }>,
) {
  const b: Record<string, jest.Mock> = {};
  b.select = jest.fn(() => b);
  b.addSelect = jest.fn(() => b);
  b.where = jest.fn(() => b);
  b.andWhere = jest.fn(() => b);
  b.groupBy = jest.fn(() => b);
  b.getRawMany = jest.fn(async () => rawRows);
  return b;
}

/**
 * The vote repo's `createQueryBuilder` is hit by BOTH the orIgnore INSERT (no
 * alias) and the recount grouped-SELECT (alias 'v'). Dispatch by alias, like
 * the W-S1 reaction spec.
 */
function makeVoteQbMock(recountRaw: Array<{ optionId: string; count: string }>) {
  const insertBuilder = makeInsertBuilder();
  const recountBuilder = makeRecountBuilder(recountRaw);
  const mock = jest.fn((alias?: string) =>
    alias === 'v' ? recountBuilder : insertBuilder,
  );
  return { mock, insertBuilder, recountBuilder };
}

const POST_ID = '22222222-2222-2222-2222-222222222222';

describe('CitizenPollService', () => {
  let service: CitizenPollService;

  // Constructor repos (outside-tx reads).
  let optionRepo: Repo;
  let voteRepo: Repo;

  // EntityManager-scoped repos (returned inside the transaction).
  let emPostRepo: Repo;
  let emOptionRepo: Repo;
  let emVoteRepo: Repo;
  let emIdentityRepo: Repo;
  let emAuditRepo: Repo;
  let em: { getRepository: (entity: { name: string }) => Repo };

  let auditSaves: Array<{ action: string; detail: unknown }>;

  beforeEach(() => {
    optionRepo = makeRepo();
    voteRepo = makeRepo();

    emPostRepo = makeRepo();
    emOptionRepo = makeRepo();
    emVoteRepo = makeRepo();
    emIdentityRepo = makeRepo();
    emAuditRepo = makeRepo();

    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });
    emIdentityRepo.findOne = jest.fn(async () => ({
      id: 'identity-1',
      displayAlias: 'สมชาย ม.',
    }));

    const emRepoByName: Record<string, Repo> = {
      CitizenPost: emPostRepo,
      CitizenPollOption: emOptionRepo,
      CitizenPollVote: emVoteRepo,
      CitizenIdentity: emIdentityRepo,
      CitizenAuditLog: emAuditRepo,
    };
    em = { getRepository: (entity: { name: string }) => emRepoByName[entity.name] };

    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
      manager: em,
      getRepository: (entity: { name: string }) =>
        emRepoByName[entity.name] ?? makeRepo(),
    };

    // W-S4: the hashtag extractor/linker — a no-op stub (extractAndLink is
    // invoked in-tx by createPoll(); these specs are hashtag-agnostic).
    const hashtagService = { extractAndLink: jest.fn(async () => undefined) };

    service = new CitizenPollService(
      optionRepo as never,
      voteRepo as never,
      hashtagService as never,
      dataSource as never,
    );
  });

  // ---------------------------------------------------------------------------
  // createPoll
  // ---------------------------------------------------------------------------

  describe('createPoll', () => {
    it('rejects fewer than 2 non-empty options', async () => {
      const dto: CreateCitizenPollDto = {
        question: 'ควรสร้างสวนสาธารณะไหม?',
        options: ['เห็นด้วย', '   '], // second is blank after trim
      };
      await expect(service.createPoll('identity-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(emPostRepo.save).not.toHaveBeenCalled();
    });

    it('rejects more than 6 options', async () => {
      const dto: CreateCitizenPollDto = {
        question: 'q',
        options: ['1', '2', '3', '4', '5', '6', '7'],
      };
      await expect(service.createPoll('identity-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(emPostRepo.save).not.toHaveBeenCalled();
    });

    it('rejects an empty question', async () => {
      const dto: CreateCitizenPollDto = {
        question: '   ',
        options: ['a', 'b'],
      };
      await expect(service.createPoll('identity-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a past closesAt (born-closed poll)', async () => {
      const dto: CreateCitizenPollDto = {
        question: 'q',
        options: ['a', 'b'],
        closesAt: new Date(Date.now() - 60_000).toISOString(),
      };
      await expect(service.createPoll('identity-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('creates a poll post + option rows + audit row for 2..6 valid options', async () => {
      emPostRepo.save = jest.fn(async (x) => ({ ...x, id: 'poll-1' }));
      let optSeq = 0;
      emOptionRepo.save = jest.fn(async (x) => ({ ...x, id: `opt-${++optSeq}` }));

      const dto: CreateCitizenPollDto = {
        question: 'ควรสร้างสวนสาธารณะไหม?',
        options: ['เห็นด้วย', 'ไม่เห็นด้วย', '  เฉย ๆ  '], // 3rd trimmed
      };

      const result = await service.createPoll('identity-1', dto);

      // post created as a poll: detail=question, geo/category null
      const createdPost = emPostRepo.create.mock.calls[0][0];
      expect(createdPost).toMatchObject({
        authorIdentityId: 'identity-1',
        postKind: 'poll',
        detail: 'ควรสร้างสวนสาธารณะไหม?',
        lat: null,
        lng: null,
        category: null,
        moderationState: 'visible',
      });
      // 3 option rows inserted in submitted order with trimmed labels
      expect(emOptionRepo.create).toHaveBeenCalledTimes(3);
      const labels = emOptionRepo.create.mock.calls.map((c) => c[0].label);
      expect(labels).toEqual(['เห็นด้วย', 'ไม่เห็นด้วย', 'เฉย ๆ']);
      const sortOrders = emOptionRepo.create.mock.calls.map((c) => c[0].sortOrder);
      expect(sortOrders).toEqual([0, 1, 2]);

      // audit row written
      expect(auditSaves[0]).toMatchObject({
        action: 'poll.create',
        detail: { optionCount: 3, hasCloseTime: false },
      });

      // returned dto carries a zeroed poll block
      expect(result.postKind).toBe('poll');
      expect(result.poll?.options).toHaveLength(3);
      expect(result.poll?.totalVotes).toBe(0);
      expect(result.poll?.closed).toBe(false);
      expect(result.poll?.options.every((o) => o.voteCount === 0)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // vote
  // ---------------------------------------------------------------------------

  describe('vote', () => {
    const visiblePoll = {
      id: POST_ID,
      postKind: 'poll',
      moderationState: 'visible',
      deletedAt: null,
      pollClosesAt: null,
      heartCount: 0,
      commentCount: 0,
    };
    const options = [
      { id: 'opt-a', postId: POST_ID, label: 'A', sortOrder: 0, voteCount: 0 },
      { id: 'opt-b', postId: POST_ID, label: 'B', sortOrder: 1, voteCount: 0 },
    ];

    beforeEach(() => {
      emPostRepo.findOne = jest.fn(async () => ({ ...visiblePoll }));
      emOptionRepo.find = jest.fn(async () =>
        options.map((o) => ({ ...o })),
      );
    });

    it('404s when the poll is missing / not a visible poll', async () => {
      emPostRepo.findOne = jest.fn(async () => null);
      await expect(
        service.vote('identity-1', POST_ID, 'opt-a'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a closed poll (pollClosesAt in the past)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        ...visiblePoll,
        pollClosesAt: new Date(Date.now() - 60_000),
      }));
      await expect(
        service.vote('identity-1', POST_ID, 'opt-a'),
      ).rejects.toMatchObject({ message: 'CITIZEN_POLL_CLOSED' });
    });

    it('rejects an option that does not belong to the poll', async () => {
      emOptionRepo.findOne = jest.fn(async () => null);
      await expect(
        service.vote('identity-1', POST_ID, 'opt-x'),
      ).rejects.toMatchObject({ message: 'CITIZEN_POLL_OPTION_INVALID' });
    });

    it('CAST: no live vote → inserts (orIgnore), recounts, returns myOptionId', async () => {
      emOptionRepo.findOne = jest.fn(async () => ({ ...options[0] }));
      emVoteRepo.findOne = jest.fn(async () => null);
      const { mock, insertBuilder } = makeVoteQbMock([{ optionId: 'opt-a', count: '1' }]);
      emVoteRepo.createQueryBuilder = mock;

      const result = await service.vote('identity-1', POST_ID, 'opt-a');

      expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
      expect(insertBuilder._values[0]).toMatchObject({
        postId: POST_ID,
        optionId: 'opt-a',
        voterIdentityId: 'identity-1',
      });
      expect(emVoteRepo.softDelete).not.toHaveBeenCalled();
      expect(result.myOptionId).toBe('opt-a');
      expect(result.totalVotes).toBe(1);
      const a = result.options.find((o) => o.id === 'opt-a');
      expect(a?.voteCount).toBe(1);
      expect(auditSaves[0]).toMatchObject({
        action: 'poll.vote',
        detail: { voted: true },
      });
    });

    it('CHANGE-VOTE: live vote on a DIFFERENT option → soft-delete old + insert new', async () => {
      emOptionRepo.findOne = jest.fn(async () => ({ ...options[1] }));
      emVoteRepo.findOne = jest.fn(async () => ({
        id: 'vote-1',
        optionId: 'opt-a',
      }));
      const { mock, insertBuilder } = makeVoteQbMock([{ optionId: 'opt-b', count: '1' }]);
      emVoteRepo.createQueryBuilder = mock;

      const result = await service.vote('identity-1', POST_ID, 'opt-b');

      // old vote soft-deleted, new one inserted
      expect(emVoteRepo.softDelete).toHaveBeenCalledWith('vote-1');
      expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
      expect(insertBuilder._values[0]).toMatchObject({ optionId: 'opt-b' });
      expect(result.myOptionId).toBe('opt-b');
    });

    it('UN-VOTE: live vote on the SAME option → soft-delete, myOptionId null', async () => {
      emOptionRepo.findOne = jest.fn(async () => ({ ...options[0] }));
      emVoteRepo.findOne = jest.fn(async () => ({
        id: 'vote-1',
        optionId: 'opt-a',
      }));
      // after un-vote the recount returns zero rows
      const { mock, insertBuilder } = makeVoteQbMock([]);
      emVoteRepo.createQueryBuilder = mock;

      const result = await service.vote('identity-1', POST_ID, 'opt-a');

      expect(emVoteRepo.softDelete).toHaveBeenCalledWith('vote-1');
      // un-vote never inserts
      expect(insertBuilder.orIgnore).not.toHaveBeenCalled();
      expect(result.myOptionId).toBeNull();
      expect(result.totalVotes).toBe(0);
      expect(auditSaves[0]).toMatchObject({ detail: { voted: false } });
    });
  });

  // ---------------------------------------------------------------------------
  // batchLoadPolls (no N+1 results) + listMyVotes (D16 owner-scoped)
  // ---------------------------------------------------------------------------

  describe('batchLoadPolls', () => {
    it('attaches options + aggregate counts per poll; skips non-poll posts', async () => {
      const posts = [
        { id: 'poll-1', postKind: 'poll', pollClosesAt: null },
        { id: 'disc-1', postKind: 'discussion', pollClosesAt: null },
      ] as never[];
      optionRepo.find = jest.fn(async () => [
        { id: 'opt-a', postId: 'poll-1', label: 'A', sortOrder: 0, voteCount: 0 },
        { id: 'opt-b', postId: 'poll-1', label: 'B', sortOrder: 1, voteCount: 0 },
      ]);
      voteRepo.createQueryBuilder = jest.fn(() =>
        makeRecountBuilder([{ optionId: 'opt-a', count: '3' }]),
      );

      const map = await service.batchLoadPolls(posts);

      expect(map.has('disc-1')).toBe(false);
      const poll = map.get('poll-1');
      expect(poll?.options).toEqual([
        { id: 'opt-a', label: 'A', voteCount: 3 },
        { id: 'opt-b', label: 'B', voteCount: 0 },
      ]);
      expect(poll?.totalVotes).toBe(3);
      expect(poll?.closed).toBe(false);
    });

    it('returns an empty map when there are no poll posts', async () => {
      const posts = [{ id: 'd', postKind: 'discussion' }] as never[];
      const map = await service.batchLoadPolls(posts);
      expect(map.size).toBe(0);
      // no option / vote queries fired for a poll-less page
      expect(optionRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('listMyVotes (D16 owner-scoped)', () => {
    it('maps the caller live votes to { [postId]: optionId } (own votes only)', async () => {
      voteRepo.find = jest.fn(async () => [
        { postId: 'poll-1', optionId: 'opt-a' },
        { postId: 'poll-2', optionId: 'opt-z' },
      ]);

      const result = await service.listMyVotes('identity-1');

      expect(voteRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ voterIdentityId: 'identity-1' }),
        }),
      );
      expect(result).toEqual({ 'poll-1': 'opt-a', 'poll-2': 'opt-z' });
    });
  });
});
