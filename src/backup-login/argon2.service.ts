import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id hashing service — SECURITY-01 §7.1 FROZEN parameters.
 *
 *   - type        : argon2id
 *   - memoryCost  : 131072 KiB (128 MiB)
 *   - timeCost    : 4 iterations
 *   - parallelism : 1
 *   - hashLength  : 32 bytes
 *   - saltLength  : 16 bytes  (argon2 lib auto-generates per-call)
 *
 * Target verify time on prod: ≥500ms. BE-01 measures on first boot;
 * <300ms or >1000ms triggers SECURITY-01 §7.1 revision (not silent).
 *
 * The npm `argon2` package emits the canonical PHC string:
 *   `$argon2id$v=19$m=131072,t=4,p=1$<salt-b64>$<hash-b64>`
 *
 * Plaintext is NEVER logged. The `verifyDummy()` method exists to
 * equalize timing on the "user-not-found" path (anti-enumeration —
 * SECURITY-01 §7.13).
 */
@Injectable()
export class Argon2Service {
  private readonly logger = new Logger(Argon2Service.name);

  /** Cached dummy hash for `verifyDummy` — generated on first call. */
  private dummyHash: string | null = null;

  private readonly options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 131072,
    timeCost: 4,
    parallelism: 1,
    hashLength: 32,
  };

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, this.options);
  }

  /**
   * Verifies a candidate plaintext against the stored Argon2 PHC string.
   *
   * Returns `false` on any error (corrupt hash, wrong shape, library
   * failure) instead of throwing — login flow already returns the
   * generic 401 on a failed verify and that is the safer fail-closed
   * behavior here.
   */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch (err) {
      this.logger.warn(
        `[Argon2.verify] failed: ${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
      );
      return false;
    }
  }

  /**
   * Timing-equalization dummy verify — SECURITY-01 §7.13.
   *
   * Called on the `user-not-found` branch of the credential pipeline so
   * that the wall-clock cost of a "no such user" attempt matches the
   * cost of a "real verify, wrong password" attempt within ±50ms. Without
   * this, an attacker can enumerate registered emails by timing the
   * response.
   *
   * The dummy hash is computed once and cached. The same plaintext is
   * NEVER hashed twice intentionally — we just exercise the verify
   * machinery.
   */
  async verifyDummy(plaintext: string): Promise<void> {
    try {
      if (!this.dummyHash) {
        // Random one-time secret — never used for any real credential.
        this.dummyHash = await this.hash(
          `__backup_login_dummy_${Date.now()}_${Math.random()}`,
        );
      }
      await argon2.verify(this.dummyHash, plaintext);
    } catch {
      // Swallow — this branch exists ONLY for timing parity; result is
      // discarded. The verify will essentially always return false
      // because the candidate cannot match the random one-time secret.
    }
  }

  /** Synchronous helper for callers that need the option header. */
  getOptions(): argon2.Options {
    return this.options;
  }
}
