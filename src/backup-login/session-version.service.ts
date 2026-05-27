import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * SECURITY-01 §7.8 — session-version invalidation.
 *
 * Single integer counter on `users.session_version`. Every issued JWT
 * (ThaiD + backup) embeds the value at issuance time. `JwtAuthGuard`
 * compares the JWT's `sessionVersion` claim against this column;
 * mismatch → 401 `SESSION_INVALIDATED`.
 *
 * Bumped on:
 *   1. Backup password change
 *   2. Super-admin backup password reset
 *   3. Super-admin backup credential revoke
 *   4. Super-admin TOTP reset
 *   5. Account auto-freeze (10 fails / 24h)
 *   6. Super-admin unfreeze (safety — kill any leftover sessions)
 *
 * Single counter — bumping invalidates BOTH ThaiD and backup sessions
 * for that user. This is the conservative default per §7.8
 * clarification.
 */
@Injectable()
export class SessionVersionService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * Atomic increment via raw UPDATE. Returns the new value.
   *
   * When `em` is supplied the bump runs inside the caller's
   * transaction (the right behavior for password change + freeze —
   * the bump MUST be visible the moment the credential row is
   * updated).
   */
  async bump(userId: string, em?: EntityManager): Promise<number> {
    const repo = em ? em.getRepository(User) : this.userRepo;
    const result = await repo
      .createQueryBuilder()
      .update(User)
      .set({ sessionVersion: () => '"session_version" + 1' })
      .where('id = :userId', { userId })
      .returning(['session_version'])
      .execute();
    const raw = (result.raw as Array<{ session_version: number }>)[0];
    return raw?.session_version ?? 0;
  }

  async read(userId: string): Promise<number> {
    const row = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'sessionVersion'],
    });
    return row?.sessionVersion ?? 0;
  }
}
