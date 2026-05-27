import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { BackupLoginAuditLog } from './entities/backup-login-audit-log.entity';
import type { BackupAttemptOutcome } from './constants/error-messages';

/**
 * Single writer for `backup_login_audit_logs` (SECURITY-01 §7.12).
 *
 * Centralizes:
 *   - the row shape (no other module may INSERT into this table)
 *   - subnet derivation (/24 IPv4, /64 IPv6) — matches the LINE
 *     per-attempt notification masking
 *   - INSERT-on-failure-throws semantics (audit MUST NOT be
 *     best-effort)
 *
 * Reads + filtered listings power the super-admin audit panel
 * (controller `GET /v1/auth/backup-login/attempts`).
 */
@Injectable()
export class BackupAttemptAuditService {
  private readonly logger = new Logger(BackupAttemptAuditService.name);

  constructor(
    @InjectRepository(BackupLoginAuditLog)
    private readonly auditRepo: Repository<BackupLoginAuditLog>,
  ) {}

  async write(args: {
    userIdOrNull: string | null;
    usernameAttempted: string;
    stage: 'init' | 'complete' | 'bootstrap';
    ip: string;
    userAgent: string | null;
    outcome: BackupAttemptOutcome;
  }): Promise<void> {
    const subnet24 = maskSubnet(args.ip);
    const ipAddress = args.ip || '0.0.0.0';
    try {
      await this.auditRepo.insert({
        userId: args.userIdOrNull,
        usernameAttempted: (args.usernameAttempted || '').slice(0, 256),
        stage: args.stage,
        ipAddress,
        subnet24,
        userAgent: args.userAgent ? args.userAgent.slice(0, 512) : null,
        outcome: args.outcome,
      });
    } catch (err) {
      // Audit failure is a hard error — re-throw so the calling
      // request fails. We never want a backup-login flow to succeed
      // silently without an audit row.
      this.logger.error(
        `[BackupAttemptAudit] write failed outcome=${args.outcome} stage=${args.stage}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async list(filters: {
    userId?: string;
    outcome?: string;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }): Promise<{
    rows: BackupLoginAuditLog[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
    const qb = this.auditRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.user', 'user')
      .orderBy('a.attemptedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    qb.where(
      new Brackets((sb) => {
        sb.where('1 = 1');
        if (filters.userId) {
          sb.andWhere('a.userId = :uid', { uid: filters.userId });
        }
        if (filters.outcome) {
          sb.andWhere('a.outcome = :oc', { oc: filters.outcome });
        }
        if (filters.from) {
          sb.andWhere('a.attemptedAt >= :from', { from: filters.from });
        }
        if (filters.to) {
          sb.andWhere('a.attemptedAt <= :to', { to: filters.to });
        }
      }),
    );

    const [rows, total] = await qb.getManyAndCount();
    return { rows, total, page, limit };
  }
}

/**
 * Expand an IPv6 address to its full 8-group form, handling the `::`
 * shorthand correctly per RFC 4291 (only one `::` allowed per address).
 *
 * Examples:
 *   `::1`           → ['0','0','0','0','0','0','0','1']
 *   `::`            → ['0','0','0','0','0','0','0','0']
 *   `2001:db8::1`   → ['2001','db8','0','0','0','0','0','1']
 *   `fe80::1:2:3:4` → ['fe80','0','0','0','1','2','3','4']
 */
function expandIpv6(ip: string): string[] {
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
    return [...headGroups, ...new Array(missing).fill('0'), ...tailGroups];
  }
  return ip.split(':');
}

/**
 * Mask IP to /24 (IPv4) or /64 (IPv6).
 *
 * The PG `inet` type accepts these as CIDR strings. Returning a plain
 * IPv4 host address when input is unparseable preserves the NOT NULL
 * constraint without crashing on bad input.
 *
 * IPv6 inputs MUST be fully expanded before slicing — the `::`
 * shorthand can only appear once per address, so naively appending
 * `::/64` to the first 4 groups produces invalid CIDR like
 * `::1:0::/64` when the input was `::1`.
 */
export function maskSubnet(ip: string | null | undefined): string {
  if (!ip) return '0.0.0.0';
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (groups.length < 4) return '::/64';
    // First 4 groups (64 bits) + ::/64 — zero out the last 64 bits.
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return '0.0.0.0/32';
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/** User-facing mask (drops the suffix). */
export function maskIpForDisplay(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (groups.length < 4) return '::';
    return `${groups.slice(0, 4).join(':')}::`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}
