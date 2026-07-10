import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { User } from '../entities/user.entity';
import { UsersService } from '../users.service';

/** Tombstone name placed on an erased staff account (PDPA right-to-erasure). */
export const ERASED_NAME = 'ผู้ใช้ที่ถูกลบ';

/** Shape of the one-object staff DSAR export (caller-owned data only). */
export interface StaffDsarExport {
  exportedAt: string;
  account: {
    id: string;
    prefix: string | null;
    firstname: string | null;
    lastname: string | null;
    email: string | null;
    phone: string | null;
    citizenId: string | null;
    emailVerifiedAt: string | null;
    consentVersion: string | null;
    consentAt: string | null;
    createdAt: string | null;
  };
  workHistory: Array<{
    id: string;
    role: string | null;
    workStatus: string | null;
    amphoe: string | null;
    localAdministrativeOrganization: string | null;
    governmentAgency: string | null;
    createdAt: string | null;
  }>;
}

/**
 * Staff PDPA DSAR (AUTH-REDESIGN §6 / §9). The staff counterpart of
 * `CitizenDsarService`: a staff user can export or erase their OWN account
 * data (no IDOR — the controller derives the id from the JWT `sub`).
 *
 * Erasure ANONYMIZES the `users` row (PII → NULL, name → tombstone), revokes
 * the backup credential, bumps `session_version` (invalidating the live JWT),
 * and soft-deletes the account. Work-history rows are RETAINED (referential +
 * record-keeping) but now point at the anonymized user.
 */
@Injectable()
export class UsersDsarService {
  private readonly logger = new Logger(UsersDsarService.name);

  constructor(
    private readonly usersService: UsersService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** RIGHT-OF-ACCESS — everything we hold about the caller, PII decrypted. */
  async exportMine(userId: string): Promise<StaffDsarExport> {
    // findOne decrypts PII + eager-loads the work-history graph.
    const user = await this.usersService.findOne(userId);
    if (!user) throw new NotFoundException('USER_NOT_FOUND');

    const workHistory = (user.workHistory ?? []).map((wh) => ({
      id: wh.id,
      role: wh.role?.name ?? null,
      workStatus: wh.workStatus?.name ?? null,
      amphoe: wh.amphoe?.name ?? null,
      localAdministrativeOrganization:
        wh.localAdministrativeOrganization?.name ?? null,
      governmentAgency: wh.governmentAgencies?.name ?? null,
      createdAt: wh.createdAt ? new Date(wh.createdAt).toISOString() : null,
    }));

    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        prefix: user.prefix ?? null,
        firstname: user.firstname ?? null,
        lastname: user.lastname ?? null,
        email: user.email ?? null,
        phone: user.phone ?? null,
        citizenId: user.citizenId ?? null,
        emailVerifiedAt: user.emailVerifiedAt
          ? new Date(user.emailVerifiedAt).toISOString()
          : null,
        consentVersion: user.consentVersion ?? null,
        consentAt: user.consentAt ? new Date(user.consentAt).toISOString() : null,
        createdAt: user.createAt ? new Date(user.createAt).toISOString() : null,
      },
      workHistory,
    };
  }

  /**
   * RIGHT-TO-ERASURE — anonymize the caller's account in ONE transaction,
   * revoke the backup credential, bump `session_version`, and soft-delete.
   */
  async eraseMine(
    userId: string,
  ): Promise<{ erased: true; counts: Record<string, number> }> {
    return this.dataSource.transaction(async (em) => {
      const userRepo = em.getRepository(User);
      const user = await userRepo.findOne({
        where: { id: userId, deletedAt: IsNull() },
      });
      if (!user) throw new NotFoundException('USER_NOT_FOUND');

      // Anonymize PII in place (raw SQL — the entity PII columns are typed
      // `string | undefined`, so a TypeORM partial-update with NULLs would
      // not typecheck). NULL the encrypted values + their HMAC indexes so
      // the row is no longer discoverable by email/phone, and replace the
      // name with a tombstone.
      await em.query(
        `UPDATE users
            SET email = NULL, email_hash = NULL,
                phone = NULL, phone_hash = NULL,
                citizen_id = NULL, citizen_id_hash = NULL,
                prefix = '', firstname = $2, lastname = '',
                line_id = NULL, profile_image_url = NULL,
                email_verified_at = NULL
          WHERE id = $1`,
        [user.id, ERASED_NAME],
      );

      // Revoke any backup credential so the anonymized account cannot log
      // in (raw SQL keeps UsersModule decoupled from the backup-login entity).
      const revoke: Array<{ id: string }> = await em.query(
        `UPDATE backup_credentials
            SET revoked_at = now(), revoked_reason = 'pdpa-erasure'
          WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
        [user.id],
      );
      const credentialsRevoked = Array.isArray(revoke) ? revoke.length : 0;

      // Bump session_version → invalidates the live JWT via JwtAuthGuard.
      await em.query(
        `UPDATE users SET session_version = session_version + 1 WHERE id = $1`,
        [user.id],
      );

      // Soft-delete the account (DeleteDateColumn `delete_at`).
      await userRepo.softDelete(user.id);

      this.logger.log(
        `users.dsar.erase userId=${user.id} at=${new Date().toISOString()}`,
      );

      return {
        erased: true as const,
        counts: { account: 1, credentialsRevoked },
      };
    });
  }
}
