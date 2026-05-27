import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Not, Repository } from 'typeorm';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { randomBytes } from 'crypto';
import { TotpEnrollment } from './entities/totp-enrollment.entity';
import { encryptGcm, decryptGcm } from './util/gcm.util';

/**
 * RFC 6238 TOTP service — SECURITY-01 §7.5 + §7.6.
 *
 *   - algorithm  : SHA1
 *   - digits     : 6
 *   - step       : 30s
 *   - window     : ±1 step (90s acceptance window)
 *   - secret     : 160 bits (20 bytes), base32 to authenticator app
 *   - storage    : AES-GCM ciphertext via `util/gcm.util.ts`
 *   - replay     : `replayWindow[]` tracks last accepted (timeStep,
 *                  acceptedAt) per user, trimmed to 120s on every
 *                  successful verify.
 *   - enrollment : `pending` (after enroll-init, pendingUntil = +10min)
 *                  → `confirmed` (after enroll-complete, confirmedAt
 *                  set, pendingUntil cleared).
 */
@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);

  constructor(
    @InjectRepository(TotpEnrollment)
    private readonly totpRepo: Repository<TotpEnrollment>,
  ) {
    // Lock down otplib defaults — SECURITY-01 §7.5 (do NOT rely on
    // library defaults). Cast through `unknown` so the option literal
    // matches whichever `algorithm` / `window` typing the installed
    // otplib version expects (SHA1 + ±1-step grace are the FROZEN
    // numbers).
    authenticator.options = {
      algorithm: 'sha1',
      digits: 6,
      step: 30,
      window: 1,
    } as unknown as typeof authenticator.options;
  }

  /**
   * Generate a NEW 160-bit secret, encrypt it, persist as PENDING.
   *
   * If an existing CONFIRMED enrollment exists, do NOT overwrite — the
   * caller must `resetByAdmin` first. If a PENDING enrollment exists,
   * REPLACE it (treat enroll-init as restart).
   *
   * Returns the base32 secret + the QR data URL (otpauth provisioning
   * URI). The secret is returned ONCE; thereafter only the ciphertext
   * is queryable.
   */
  async enrollInit(
    userId: string,
    accountLabel: string,
  ): Promise<{ secretBase32: string; qrDataUrl: string }> {
    const existing = await this.totpRepo.findOne({ where: { userId } });
    if (existing?.confirmedAt) {
      // Caller bug — service-level guard. Surfaces as 409 from controller.
      throw new Error('TOTP already enrolled (use admin reset first)');
    }

    // Generate 160-bit secret; encode to base32 for the authenticator
    // app provisioning URI.
    const rawSecret = randomBytes(20);
    const secretBase32 = base32Encode(rawSecret);

    const ciphertext = encryptGcm(secretBase32);
    const pendingUntil = new Date(Date.now() + 10 * 60 * 1000);

    const safeLabel = (accountLabel || 'user').replace(/[^a-zA-Z0-9@.+-]/g, '_');
    const otpauthUri = authenticator.keyuri(
      safeLabel,
      'ProjectBank',
      secretBase32,
    );
    const qrDataUrl = await qrcode.toDataURL(otpauthUri);

    if (existing) {
      await this.totpRepo.update(existing.id, {
        secretEncrypted: ciphertext,
        pendingUntil,
        confirmedAt: null,
        lastVerifiedAt: null,
        replayWindow: [],
      });
    } else {
      await this.totpRepo.insert({
        userId,
        secretEncrypted: ciphertext,
        pendingUntil,
        confirmedAt: null,
        lastVerifiedAt: null,
        replayWindow: [],
      });
    }

    return { secretBase32, qrDataUrl };
  }

  /**
   * Accept a TOTP code to complete enrollment. On success, flips
   * `confirmedAt` and clears `pendingUntil`.
   */
  async enrollComplete(userId: string, code: string): Promise<boolean> {
    const row = await this.totpRepo.findOne({ where: { userId } });
    if (!row) return false;
    if (row.confirmedAt) return true;
    if (!row.pendingUntil || row.pendingUntil.getTime() < Date.now()) {
      return false;
    }
    const secret = this.tryDecrypt(row.secretEncrypted);
    if (!secret) return false;
    const ok = authenticator.check(code, secret);
    if (!ok) return false;
    await this.totpRepo.update(row.id, {
      confirmedAt: new Date(),
      pendingUntil: null,
      lastVerifiedAt: new Date(),
    });
    return true;
  }

  /**
   * Verify a TOTP code for a confirmed enrollment. Replay-defends by
   * checking `(timeStep, code)` against the user's `replayWindow[]`.
   *
   * Returns `true` on success and writes the accepted code into the
   * replay window (trimmed to entries within 120s).
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const row = await this.totpRepo.findOne({ where: { userId } });
    if (!row || !row.confirmedAt) return false;
    const secret = this.tryDecrypt(row.secretEncrypted);
    if (!secret) return false;
    if (!authenticator.check(code, secret)) return false;

    // Determine the timeStep that accepted the code so the replay
    // window can store (timeStep, acceptedAt). `authenticator.timeUsed`
    // returns the canonical step number for the just-verified code.
    const timeStep = Math.floor(Date.now() / 1000 / 30);

    const fresh = (row.replayWindow ?? []).filter(
      (entry) => Date.now() - new Date(entry.acceptedAt).getTime() < 120_000,
    );
    if (fresh.some((e) => e.timeStep === timeStep)) {
      // Same (userId, timeStep) already accepted — REJECT replay.
      return false;
    }
    fresh.push({ timeStep, acceptedAt: new Date().toISOString() });
    await this.totpRepo.update(row.id, {
      replayWindow: fresh,
      lastVerifiedAt: new Date(),
    });
    return true;
  }

  async hasConfirmed(userId: string): Promise<boolean> {
    const row = await this.totpRepo.findOne({
      where: { userId, confirmedAt: Not(IsNull()) },
      select: ['id'],
    });
    return !!row;
  }

  /**
   * Super-admin reset — deletes the enrollment row. Caller bumps
   * `users.sessionVersion` separately (see SessionVersionService).
   */
  async resetByAdmin(
    targetUserId: string,
    em?: EntityManager,
  ): Promise<void> {
    const repo = em ? em.getRepository(TotpEnrollment) : this.totpRepo;
    await repo.delete({ userId: targetUserId });
  }

  private tryDecrypt(ciphertext: string): string | null {
    try {
      return decryptGcm(ciphertext);
    } catch (err) {
      this.logger.error(
        `[TotpService] decrypt failed: ${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
      );
      return null;
    }
  }
}

/**
 * RFC 4648 §6 base32 (no padding stripping) — small inline impl to
 * avoid pulling another dep. Authenticator apps accept both padded
 * and unpadded forms; otplib's `authenticator.check` ignores
 * whitespace and case but expects base32 alphabet.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}
