import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { PasswordHistory } from './entities/password-history.entity';
import { Argon2Service } from './argon2.service';
import { WEAK_PASSWORD_CODE } from './constants/error-messages';

/**
 * SECURITY-01 §7.2 + §7.4 password policy.
 *
 *   - 12-128 chars
 *   - upper + lower + digit + symbol (regex)
 *   - reject top-1000 dictionary words (Thai + English)
 *   - reject normalized-edit-distance from username < 3
 *   - reject any of the user's last 5 password hashes (Argon2 verify)
 *
 * Plaintext is NEVER logged.
 */
@Injectable()
export class PasswordPolicyService {
  private readonly logger = new Logger(PasswordPolicyService.name);

  private readonly SYMBOL_RE = /[!@#$%^&*()_\-+=\[\]{};:,.?/~]/;
  private readonly UPPER_RE = /[A-Z]/;
  private readonly LOWER_RE = /[a-z]/;
  private readonly DIGIT_RE = /[0-9]/;

  private blacklist: Set<string> = new Set();

  constructor(
    @InjectRepository(PasswordHistory)
    private readonly historyRepo: Repository<PasswordHistory>,
    private readonly argon2: Argon2Service,
  ) {
    this.loadBlacklist();
  }

  /**
   * Loaded once at boot. The file may not exist on a fresh checkout —
   * that is acceptable: the blacklist contributes ONE of several
   * defense-in-depth layers; complexity + length + history-no-reuse +
   * username-similarity still apply.
   */
  private loadBlacklist(): void {
    // Try several candidate locations so the file is found whether
    // running via ts-node (src/) or compiled to dist/.
    const candidates = [
      path.resolve(__dirname, 'data', 'dictionary-blacklist.txt'),
      path.resolve(
        process.cwd(),
        'src',
        'backup-login',
        'data',
        'dictionary-blacklist.txt',
      ),
      path.resolve(
        process.cwd(),
        'dist',
        'src',
        'backup-login',
        'data',
        'dictionary-blacklist.txt',
      ),
    ];
    try {
      const filePath = candidates.find((p) => fs.existsSync(p));
      if (!filePath) {
        this.logger.warn(
          '[PasswordPolicy] dictionary-blacklist.txt not found; complexity-only mode',
        );
        return;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
      this.blacklist = new Set(lines);
      this.logger.log(
        `[PasswordPolicy] loaded ${this.blacklist.size} dictionary entries from ${filePath}`,
      );
    } catch (err) {
      this.logger.error(
        `[PasswordPolicy] failed to load blacklist: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Validates a candidate password against the full policy.
   *
   * Throws `BadRequestException({ code: 'WEAK_PASSWORD', message })` on
   * any failure. The `message` is a Thai-friendly hint describing the
   * first failed rule. Plaintext is never logged.
   *
   * When `userId` is provided the history-no-reuse check runs (Argon2
   * verify against each of the last 5 stored hashes). On `userId =
   * null` only the structural rules apply (initial issuance).
   */
  async validate(
    plaintext: string,
    username: string,
    userId: string | null,
  ): Promise<void> {
    if (typeof plaintext !== 'string' || plaintext.length < 12) {
      this.reject('รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร');
    }
    if (plaintext.length > 128) {
      this.reject('รหัสผ่านยาวเกินไป');
    }
    if (!this.UPPER_RE.test(plaintext)) {
      this.reject('ต้องมีตัวพิมพ์ใหญ่อย่างน้อย 1 ตัว');
    }
    if (!this.LOWER_RE.test(plaintext)) {
      this.reject('ต้องมีตัวพิมพ์เล็กอย่างน้อย 1 ตัว');
    }
    if (!this.DIGIT_RE.test(plaintext)) {
      this.reject('ต้องมีตัวเลขอย่างน้อย 1 ตัว');
    }
    if (!this.SYMBOL_RE.test(plaintext)) {
      this.reject('ต้องมีอักขระพิเศษอย่างน้อย 1 ตัว');
    }

    const normalized = plaintext.toLowerCase();
    if (this.blacklist.has(normalized)) {
      this.reject('รหัสผ่านนี้พบในรายการรหัสที่ใช้บ่อย');
    }

    if (username && username.length > 0) {
      const usernameNorm = username.toLowerCase();
      const distance = this.editDistance(normalized, usernameNorm);
      if (distance < 3) {
        this.reject('รหัสผ่านใกล้เคียงกับชื่อผู้ใช้มากเกินไป');
      }
    }

    if (userId) {
      const history = await this.historyRepo.find({
        where: { userId },
        order: { createdAt: 'DESC' },
        take: 5,
      });
      for (const row of history) {
        const matches = await this.argon2.verify(row.passwordHash, plaintext);
        if (matches) {
          this.reject('รหัสผ่านนี้เคยใช้ในอดีต');
        }
      }
    }
  }

  /**
   * Insert a new history row and trim the user's history to the 5
   * newest. Single transactional call — caller passes the already-hashed
   * `passwordHash` (the PHC string), never plaintext.
   */
  async push(userId: string, passwordHash: string): Promise<void> {
    await this.historyRepo.insert({ userId, passwordHash });
    // Trim — load ids beyond the 5 newest and delete them.
    const all = await this.historyRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      select: ['id'],
    });
    const stale = all.slice(5);
    if (stale.length > 0) {
      await this.historyRepo.delete(stale.map((r) => r.id));
    }
  }

  /**
   * Hard-delete every password-history row for the user.
   *
   * Wave wave-backup-login-profile-self-enroll / BE-01 — invoked by
   * `BackupLoginService.selfEnrollPassword` when re-activating a
   * previously-revoked credential row. Re-activation is conceptually
   * a fresh credential; the prior history would otherwise prevent
   * the user from reusing a password they used long ago under the
   * old (revoked) credential, which is a legitimate use case.
   *
   * Accepts an optional `EntityManager` so the call runs inside the
   * caller's transaction (history reset MUST commit atomically with
   * the credential re-activation — partial state would either lock
   * the user out of common passwords or leak history boundaries).
   */
  async reset(userId: string, em?: EntityManager): Promise<void> {
    const repo = em ? em.getRepository(PasswordHistory) : this.historyRepo;
    await repo.delete({ userId });
  }

  /**
   * Levenshtein edit distance — used by §7.2 username-similarity rule.
   *
   * O(m * n) memory + time. Safe for capped inputs (username ≤ 256,
   * password ≤ 128 per DTO).
   */
  private editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0),
    );
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost,
        );
      }
    }
    return dp[m][n];
  }

  private reject(message: string): never {
    throw new BadRequestException({
      code: WEAK_PASSWORD_CODE,
      message,
    });
  }
}
