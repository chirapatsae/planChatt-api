import { UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

// encryption.util throws at import under jest (no .env.test) — mock it so the
// spec can import the service. (project memory: project_encryption_util_test_env)
jest.mock('src/util/encryption.util', () => ({
  hashCitizenId: (v: string) => `nid:${v}`,
  hashSecret: (v: string) => `sub:${v}`,
}));

import { CitizenAuthService } from './citizen-auth.service';

const ISS = 'https://imauth.bora.dopa.go.th';
const makeToken = (claims: Record<string, unknown>) => jwt.sign(claims, 'unit-test-key');

describe('CitizenAuthService', () => {
  let service: CitizenAuthService;
  let repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let jwtService: { sign: jest.Mock };

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: 'identity-1', sessionVersion: 0, ...x })),
    };
    jwtService = { sign: jest.fn(() => 'signed.citizen.jwt') };
    service = new CitizenAuthService(repo as never, jwtService as never);
  });

  it('rejects an id_token with the wrong issuer', async () => {
    const token = makeToken({ sub: 's', iss: 'https://evil.example', pid: '1' });
    await expect(service.loginWithThaid(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an id_token missing pid', async () => {
    const token = makeToken({ sub: 's', iss: ISS });
    await expect(service.loginWithThaid(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an id_token whose exp is in the past (W-SEC-1)', async () => {
    // exp 1h ago — well past the ~60s clock tolerance.
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = makeToken({ sub: 's', iss: ISS, pid: '1', exp: past });
    await expect(service.loginWithThaid(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts an id_token with no exp claim (decode-only contract preserved)', async () => {
    repo.findOne.mockResolvedValue(null);
    // jwt.sign with no exp option leaves the claim absent.
    const token = makeToken({ sub: 'sub-noexp', iss: ISS, pid: '1234567890123' });
    const result = await service.loginWithThaid(token);
    expect(result.accessToken).toBe('signed.citizen.jwt');
  });

  it('accepts an id_token whose exp is in the future', async () => {
    repo.findOne.mockResolvedValue(null);
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = makeToken({ sub: 'sub-future', iss: ISS, pid: '1234567890123', exp: future });
    const result = await service.loginWithThaid(token);
    expect(result.accessToken).toBe('signed.citizen.jwt');
  });

  it('creates a citizen identity on first login and issues an aud:citizen token', async () => {
    repo.findOne.mockResolvedValue(null);
    const token = makeToken({
      sub: 'sub-1',
      iss: ISS,
      pid: '1234567890123',
      given_name: 'สมชาย',
      family_name: 'มานะ',
    });

    const result = await service.loginWithThaid(token);

    // Upsert into citizen_identities — masked alias, hashes set, PII enc left NULL.
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        thaidSubHash: 'sub:sub-1',
        nationalIdHash: 'nid:1234567890123',
        displayAlias: 'สมชาย ม.',
        status: 'active',
      }),
    );
    const created = repo.create.mock.calls[0][0];
    expect(created.nationalIdEnc).toBeUndefined();
    expect(created.fullNameEnc).toBeUndefined();

    // Token is signed with audience:'citizen' (the isolation boundary).
    expect(jwtService.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'identity-1', typ: 'citizen', loginMethod: 'thaid' }),
      expect.objectContaining({ audience: 'citizen', expiresIn: '30d' }),
    );
    expect(result).toEqual({
      accessToken: 'signed.citizen.jwt',
      profile: { id: 'identity-1', displayAlias: 'สมชาย ม.' },
    });
  });

  it('reuses an existing identity on a returning login', async () => {
    repo.findOne.mockResolvedValue({
      id: 'identity-2',
      displayAlias: 'น้ำฝน ป.',
      sessionVersion: 0,
    });
    const token = makeToken({ sub: 'sub-2', iss: ISS, pid: '9999999999999' });

    const result = await service.loginWithThaid(token);

    expect(repo.create).not.toHaveBeenCalled();
    expect(result.profile.id).toBe('identity-2');
  });
});
