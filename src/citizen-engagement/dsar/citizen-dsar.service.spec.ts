import { NotFoundException } from '@nestjs/common';

import {
  CitizenDsarService,
  ERASED_DISPLAY_ALIAS,
} from './citizen-dsar.service';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenBlock } from '../entities/citizen-block.entity';
import { CitizenBookmark } from '../entities/citizen-bookmark.entity';
import { CitizenFollow } from '../entities/citizen-follow.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenPollVote } from '../entities/citizen-poll-vote.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenPostComment } from '../entities/citizen-post-comment.entity';
import { CitizenPostMedia } from '../entities/citizen-post-media.entity';
import { CitizenPostReaction } from '../entities/citizen-post-reaction.entity';
import { CitizenReport } from '../entities/citizen-report.entity';
import { CitizenStory } from '../entities/citizen-story.entity';

/**
 * Unit spec for CitizenDsarService (W-G1 PDPA DSAR).
 *
 * The service does NOT hash anything (no encryption.util import), so there is
 * NO jest.mock('src/util/encryption.util'). We mock the injected identity repo
 * + a DataSource whose `.getRepository(Entity)` returns a per-entity stub repo
 * and whose `.transaction(cb)` invokes the callback with a mock EntityManager
 * that hands back the SAME per-entity stub repos.
 */

const ME = 'identity-me';
const OTHER = 'identity-other';
const JOINED = new Date('2026-01-01T00:00:00.000Z');

type StubRepo = {
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  softDelete: jest.Mock;
  // hardDeleteOwned (story view/reaction, chat read-state) + chat-body update.
  delete: jest.Mock;
  update: jest.Mock;
};

function makeRepo(): StubRepo {
  return {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    save: jest.fn(async (x) => x),
    create: jest.fn((x) => x),
    softDelete: jest.fn(async () => ({ affected: 0 })),
    delete: jest.fn(async () => ({ affected: 1 })),
    update: jest.fn(async () => ({ affected: 1 })),
  };
}

describe('CitizenDsarService', () => {
  let service: CitizenDsarService;
  let identityRepo: StubRepo;
  let repoByName: Record<string, StubRepo>;
  let auditSaves: Array<Record<string, unknown>>;

  beforeEach(() => {
    identityRepo = makeRepo();
    auditSaves = [];

    repoByName = {
      CitizenIdentity: identityRepo,
      CitizenPost: makeRepo(),
      CitizenPostComment: makeRepo(),
      CitizenPostReaction: makeRepo(),
      CitizenPostMedia: makeRepo(),
      CitizenBookmark: makeRepo(),
      CitizenFollow: makeRepo(),
      CitizenPollVote: makeRepo(),
      CitizenStory: makeRepo(),
      // FB-6 ephemeral story engagement — HARD-deleted on erasure (no soft col).
      CitizenStoryView: makeRepo(),
      CitizenStoryReaction: makeRepo(),
      CitizenBlock: makeRepo(),
      CitizenReport: makeRepo(),
      CitizenNotification: makeRepo(),
      // Community chat — caller's messages soft-deleted + body-nulled; read-state deleted.
      CitizenChatConversation: makeRepo(),
      CitizenChatMessage: makeRepo(),
      CitizenChatReadState: makeRepo(),
      CitizenAuditLog: makeRepo(),
    };
    repoByName.CitizenAuditLog.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    const getRepository = (entity: { name: string }) => repoByName[entity.name];
    const em = { getRepository };
    const dataSource = {
      getRepository,
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    service = new CitizenDsarService(
      identityRepo as never,
      dataSource as never,
    );
  });

  // ---------------------------------------------------------------------------
  // exportMine
  // ---------------------------------------------------------------------------
  describe('exportMine', () => {
    beforeEach(() => {
      identityRepo.findOne = jest.fn(async () => ({
        id: ME,
        displayAlias: 'สมชาย ม.',
        consentVersion: 'v1',
        createdAt: JOINED,
        // PII columns present on the row — MUST NOT leak into the export.
        thaidSubHash: 'THAID_HASH',
        nationalIdHash: 'NID_HASH',
        nationalIdEnc: 'iv:cipher',
        fullNameEnc: 'iv:cipher2',
        sessionVersion: 0,
        status: 'active',
      }));
    });

    it('exports the caller-owned content collections', async () => {
      repoByName.CitizenPost.find = jest.fn(async () => [
        { id: 'post-1', authorIdentityId: ME, title: 'ถนนพัง', createdAt: JOINED },
      ]);
      repoByName.CitizenPostComment.find = jest.fn(async () => [
        { id: 'c-1', authorIdentityId: ME, text: 'ดี', createdAt: JOINED },
      ]);

      const out = await service.exportMine(ME);

      expect(out.posts).toHaveLength(1);
      expect(out.posts[0]).toMatchObject({ id: 'post-1' });
      expect(out.comments).toHaveLength(1);
      // every collection key is present
      expect(out).toEqual(
        expect.objectContaining({
          posts: expect.any(Array),
          comments: expect.any(Array),
          reactions: expect.any(Array),
          bookmarks: expect.any(Array),
          follows: expect.any(Array),
          pollVotes: expect.any(Array),
          stories: expect.any(Array),
          blocks: expect.any(Array),
          reports: expect.any(Array),
        }),
      );
    });

    it('profile carries alias + joinedAt + consentVersion and NEVER PII', async () => {
      const out = await service.exportMine(ME);

      expect(out.profile).toEqual({
        id: ME,
        displayAlias: 'สมชาย ม.',
        joinedAt: JOINED.toISOString(),
        consentVersion: 'v1',
      });
      // PII guard — no hash / enc field anywhere in the serialized export
      const json = JSON.stringify(out);
      expect(json).not.toContain('THAID_HASH');
      expect(json).not.toContain('NID_HASH');
      expect(json).not.toContain('iv:cipher');
      expect(out.profile).not.toHaveProperty('thaidSubHash');
      expect(out.profile).not.toHaveProperty('nationalIdHash');
      expect(out.profile).not.toHaveProperty('nationalIdEnc');
      expect(out.profile).not.toHaveProperty('fullNameEnc');
    });

    it('is owner-scoped: every content read filters on the caller identity', async () => {
      await service.exportMine(ME);

      expect(repoByName.CitizenPost.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { authorIdentityId: ME } }),
      );
      expect(repoByName.CitizenPostReaction.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { identityId: ME } }),
      );
      expect(repoByName.CitizenBookmark.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { bookmarkerIdentityId: ME } }),
      );
      expect(repoByName.CitizenReport.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { reporterIdentityId: ME } }),
      );
    });

    it('throws 404 when the identity is missing/deleted', async () => {
      identityRepo.findOne = jest.fn(async () => null);
      await expect(service.exportMine('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // eraseMine
  // ---------------------------------------------------------------------------
  describe('eraseMine', () => {
    let identity: Record<string, unknown>;

    beforeEach(() => {
      identity = {
        id: ME,
        displayAlias: 'สมชาย ม.',
        thaidSubHash: 'THAID_HASH',
        nationalIdHash: 'NID_HASH',
        nationalIdEnc: 'iv:cipher',
        fullNameEnc: 'iv:cipher2',
        emailEnc: 'iv:emailcipher',
        emailHash: 'EMAIL_HASH',
        passwordHash: 'argon2hash',
        googleSubHash: 'GOOGLE_SUB_HASH',
        emailVerifiedAt: JOINED,
        status: 'active',
        sessionVersion: 4,
        deletedAt: null,
        createdAt: JOINED,
        consentVersion: 'v1',
      };
      identityRepo.findOne = jest.fn(async () => identity);
      // each content repo reports it soft-deleted 1 row
      for (const name of Object.keys(repoByName)) {
        if (name === 'CitizenIdentity' || name === 'CitizenAuditLog') continue;
        repoByName[name].softDelete = jest.fn(async () => ({ affected: 1 }));
      }
    });

    it('soft-deletes ALL the caller content collections (owner-scoped)', async () => {
      await service.eraseMine(ME);

      const expectCriteria: Array<[string, Record<string, string>]> = [
        ['CitizenPost', { authorIdentityId: ME }],
        ['CitizenPostMedia', { ownerIdentityId: ME }],
        ['CitizenPostComment', { authorIdentityId: ME }],
        ['CitizenPostReaction', { identityId: ME }],
        ['CitizenBookmark', { bookmarkerIdentityId: ME }],
        ['CitizenFollow', { followerIdentityId: ME }],
        ['CitizenPollVote', { voterIdentityId: ME }],
        ['CitizenStory', { authorIdentityId: ME }],
        ['CitizenBlock', { blockerIdentityId: ME }],
        ['CitizenReport', { reporterIdentityId: ME }],
      ];
      for (const [name, criteria] of expectCriteria) {
        expect(repoByName[name].softDelete).toHaveBeenCalledWith(criteria);
        // never scoped to any OTHER identity
        expect(repoByName[name].softDelete).not.toHaveBeenCalledWith(
          expect.objectContaining({
            authorIdentityId: OTHER,
          }),
        );
      }
    });

    it('anonymizes the identity, bumps session_version, sets deleted', async () => {
      await service.eraseMine(ME);

      expect(identity.nationalIdHash).toBeNull();
      expect(identity.thaidSubHash).toBe('');
      expect(identity.nationalIdEnc).toBeNull();
      expect(identity.fullNameEnc).toBeNull();
      // AUTH-REDESIGN PDPA scrub — email/password/Google auth PII erased so the
      // encrypted email doesn't survive erasure and the address is freed.
      expect(identity.emailEnc).toBeNull();
      expect(identity.emailHash).toBeNull();
      expect(identity.passwordHash).toBeNull();
      expect(identity.googleSubHash).toBeNull();
      expect(identity.emailVerifiedAt).toBeNull();
      expect(identity.displayAlias).toBe(ERASED_DISPLAY_ALIAS);
      expect(identity.status).toBe('deleted');
      // session_version bumped (invalidates the live JWT via CitizenJwtGuard)
      expect(identity.sessionVersion).toBe(5);
      expect(identity.deletedAt).toBeInstanceOf(Date);
      expect(identityRepo.save).toHaveBeenCalledWith(identity);
    });

    it('writes a retained erasure audit row with NO raw PII', async () => {
      await service.eraseMine(ME);

      expect(auditSaves).toHaveLength(1);
      const row = auditSaves[0];
      expect(row).toMatchObject({
        actorKind: 'citizen',
        actorId: ME,
        action: 'account.erase',
        targetKind: 'identity',
        targetId: ME,
      });
      // audit detail carries ONLY per-kind counts — never alias / hash / enc
      const json = JSON.stringify(row);
      expect(json).not.toContain('THAID_HASH');
      expect(json).not.toContain('NID_HASH');
      expect(json).not.toContain('iv:cipher');
      expect(json).not.toContain('สมชาย');
      expect(row.detail).toEqual({ counts: expect.any(Object) });
    });

    it('returns counts of erased rows', async () => {
      const result = await service.eraseMine(ME);
      expect(result.erased).toBe(true);
      expect(result.counts.posts).toBe(1);
      expect(result.counts.reactions).toBe(1);
    });

    it('throws 404 and mutates nothing when the identity is missing', async () => {
      identityRepo.findOne = jest.fn(async () => null);
      await expect(service.eraseMine('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(identityRepo.save).not.toHaveBeenCalled();
      expect(repoByName.CitizenPost.softDelete).not.toHaveBeenCalled();
      expect(auditSaves).toHaveLength(0);
    });
  });
});
