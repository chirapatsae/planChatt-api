import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import axios from 'axios';

import { CitizenMediaModerationService } from './citizen-media-moderation.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Unit spec for the W-M1 content-moderation seam.
 *
 * Proves: default (no env) ALLOWS + warns ONCE; a configured provider that
 * DENIES → 422; a configured provider that THROWS / times out → 422
 * (FAIL-CLOSED); env-gating decides the path; and the moderation bytes are
 * never logged (PDPA).
 */
describe('CitizenMediaModerationService', () => {
  const ENV_URL = 'CITIZEN_MEDIA_MODERATION_URL';
  const ENV_SECRET = 'CITIZEN_MEDIA_MODERATION_SECRET';
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  let service: CitizenMediaModerationService;
  const savedUrl = process.env[ENV_URL];
  const savedSecret = process.env[ENV_SECRET];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[ENV_URL];
    delete process.env[ENV_SECRET];
    service = new CitizenMediaModerationService();
  });

  afterAll(() => {
    if (savedUrl === undefined) delete process.env[ENV_URL];
    else process.env[ENV_URL] = savedUrl;
    if (savedSecret === undefined) delete process.env[ENV_SECRET];
    else process.env[ENV_SECRET] = savedSecret;
  });

  describe('unconfigured (no provider URL)', () => {
    it('allows images and returns "unconfigured"', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      await expect(service.assertAllowed(bytes, 'image/jpeg')).resolves.toBe(
        'unconfigured',
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('warns ONCE per process even across multiple calls', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      await service.assertAllowed(bytes, 'image/jpeg');
      await service.assertAllowed(bytes, 'image/png');
      await service.assertAllowed(bytes, 'image/jpeg');
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('configured provider (fail-closed)', () => {
    beforeEach(() => {
      process.env[ENV_URL] = 'https://moderation.example/scan';
    });

    it('allows on an allow verdict and returns "provider"', async () => {
      mockedAxios.post.mockResolvedValue({ data: { allowed: true } } as never);
      await expect(service.assertAllowed(bytes, 'image/jpeg')).resolves.toBe(
        'provider',
      );
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('rejects with 422 on a deny verdict', async () => {
      mockedAxios.post.mockResolvedValue({ data: { allowed: false } } as never);
      await expect(
        service.assertAllowed(bytes, 'image/jpeg'),
      ).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'CITIZEN_MEDIA_REJECTED',
      });
    });

    it('rejects with 422 on a verdict:"deny" string verdict', async () => {
      mockedAxios.post.mockResolvedValue({ data: { verdict: 'deny' } } as never);
      await expect(
        service.assertAllowed(bytes, 'image/jpeg'),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('FAILS CLOSED (422) when the provider throws / times out', async () => {
      mockedAxios.post.mockRejectedValue(new Error('ECONNABORTED timeout'));
      await expect(
        service.assertAllowed(bytes, 'image/jpeg'),
      ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY });
    });

    it('FAILS CLOSED (422) on an unrecognised provider response schema', async () => {
      mockedAxios.post.mockResolvedValue({ data: { weird: 1 } } as never);
      await expect(
        service.assertAllowed(bytes, 'image/jpeg'),
      ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY });
    });

    it('sends a Bearer secret when configured and posts to the env URL only', async () => {
      process.env[ENV_SECRET] = 'topsecret';
      mockedAxios.post.mockResolvedValue({ data: { allowed: true } } as never);

      await service.assertAllowed(bytes, 'image/jpeg');

      const [url, , config] = mockedAxios.post.mock.calls[0];
      expect(url).toBe('https://moderation.example/scan');
      expect((config as { headers: Record<string, string> }).headers.Authorization).toBe(
        'Bearer topsecret',
      );
      expect((config as { timeout: number }).timeout).toBeGreaterThan(0);
    });

    it('never logs the moderation bytes (PDPA)', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockedAxios.post.mockRejectedValue(new Error('boom'));
      const secret = Buffer.from('SECRET_PIXELS').toString('base64');

      await expect(
        service.assertAllowed(Buffer.from('SECRET_PIXELS'), 'image/jpeg'),
      ).rejects.toBeInstanceOf(HttpException);

      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('SECRET_PIXELS');
      expect(logged).not.toContain(secret);
    });
  });
});
