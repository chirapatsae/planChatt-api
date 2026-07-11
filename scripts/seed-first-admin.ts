/**
 * seed-first-admin.ts — AUTH-REDESIGN (2026-07-08) first-admin bootstrap.
 *
 * WHY THIS EXISTS
 * ---------------
 * After ThaID was removed, staff accounts are created by an admin via
 * `POST /auth/members`. But that endpoint itself requires an authenticated
 * admin — a chicken-and-egg. Existing accounts came from ThaID and carry NO
 * email/password, so none of them can log in either. This script breaks the
 * deadlock by creating the FIRST email + password super-admin, reusing the
 * exact same, live-tested code paths as `/auth/members`
 * (UsersService.createMember → WorkHistoryService.create →
 * BackupLoginService.issueCredential).
 *
 * The created admin gets a RANDOM one-time password (printed once). On first
 * login they are forced to change it and enrol TOTP — same as any member.
 *
 * USAGE
 * -----
 *   # development
 *   SEED_ADMIN_EMAIL=admin@yourorg.go.th \
 *   SEED_ADMIN_FIRSTNAME=สมชาย SEED_ADMIN_LASTNAME=ผู้ดูแล \
 *   npm run seed:admin
 *
 *   # production
 *   NODE_ENV=production SEED_ADMIN_EMAIL=... npm run seed:admin
 *
 * OPTIONAL ENV
 *   SEED_ADMIN_PREFIX     (default "นาย")
 *   SEED_ADMIN_ROLE       (default "super-admin"; also: admin | c-level)
 *   SEED_ADMIN_PASSWORD   (default: a random one-time password is generated
 *                          and printed. If set, that password is used as the
 *                          initial one instead — still forced-change + TOTP
 *                          enrol on first login, so a weak value is fine.)
 *   SEED_AMPHOE_ID        (default "3001" — the home-org amphoe เมืองนครราชสีมา;
 *                          single-LAO rescope 2026-07. Must already exist —
 *                          OrgSeedService seeds it on boot. An unresolved id is
 *                          a hard exit(1), NOT a first-row fallback.)
 *   SEED_LAO_ID           (default "3001027" — เทศบาลตำบลหนองกระทุ่ม, the home
 *                          org. Must already exist; unresolved id → exit(1).)
 *
 * SAFETY
 *   - Refuses to run if SEED_ADMIN_EMAIL is missing.
 *   - Refuses (exit 1) if the email is already registered.
 *   - Idempotent-ish: re-running with a NEW email creates another admin.
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { UsersService } from '../src/users/users.service';
import { WorkHistoryService } from '../src/work-history/work-history.service';
import { BackupLoginService } from '../src/backup-login/backup-login.service';
import { Argon2Service } from '../src/backup-login/argon2.service';

async function main(): Promise<number> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const firstname = process.env.SEED_ADMIN_FIRSTNAME?.trim() || 'ผู้ดูแล';
  const lastname = process.env.SEED_ADMIN_LASTNAME?.trim() || 'ระบบ';
  const prefix = process.env.SEED_ADMIN_PREFIX?.trim() || 'นาย';
  const roleName = process.env.SEED_ADMIN_ROLE?.trim() || 'super-admin';

  if (!email) {
    console.error('❌ SEED_ADMIN_EMAIL is required. See the header of this file for usage.');
    return 1;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const dataSource = app.get(DataSource);
    const users = app.get(UsersService, { strict: false });
    const workHistory = app.get(WorkHistoryService, { strict: false });
    const backupLogin = app.get(BackupLoginService, { strict: false });

    // ── Resolve role + approved workStatus + org placement ────────────
    const role = await dataSource.query(
      'SELECT id FROM roles WHERE name = $1 LIMIT 1',
      [roleName],
    );
    if (!role[0]) {
      console.error(`❌ Role "${roleName}" not found. Valid: super-admin | admin | c-level | staff | user`);
      return 1;
    }
    const approved = await dataSource.query(
      "SELECT id FROM work_status WHERE name = 'approved' LIMIT 1",
    );
    if (!approved[0]) {
      console.error('❌ work_status "approved" not found — is the DB seeded?');
      return 1;
    }

    // Single-LAO deployment (2026-07 rescope): default to the HOME org
    // เทศบาลตำบลหนองกระทุ่ม = (amphoe '3001', lao '3001027') — the pair the
    // whole app treats as the full-feature agency. OrgSeedService guarantees
    // these rows exist on first boot, so this seed just needs to point at them;
    // SEED_AMPHOE_ID / SEED_LAO_ID still override. We verify the specific row
    // exists (WorkHistoryService.create resolves amphoe/LAO via findOneBy, which
    // ignores soft-deleted rows — amphoes soft-delete = camelCase "deletedAt",
    // LAO = snake_case delete_at).
    const amphoeId = process.env.SEED_AMPHOE_ID?.trim() || '3001';
    const amphoeRow = await dataSource.query(
      'SELECT id, name FROM amphoes WHERE id = $1 AND "deletedAt" IS NULL',
      [amphoeId],
    );
    if (!amphoeRow[0]) {
      console.error(
        `❌ Amphoe "${amphoeId}" not found. Start the app once (OrgSeedService seeds the home org) or set SEED_AMPHOE_ID to an existing amphoe.`,
      );
      return 1;
    }
    const laoId = process.env.SEED_LAO_ID?.trim() || '3001027';
    const laoRow = await dataSource.query(
      'SELECT id, name FROM local_administrative_organizations WHERE id = $1 AND delete_at IS NULL',
      [laoId],
    );
    if (!laoRow[0]) {
      console.error(
        `❌ Local administrative organization "${laoId}" not found. Start the app once (OrgSeedService seeds the home org) or set SEED_LAO_ID to an existing LAO.`,
      );
      return 1;
    }
    console.log(
      `▶ Placing under "${laoRow[0].name}" (${laoId}) in amphoe "${amphoeRow[0].name}" (${amphoeId}).`,
    );

    // ── 1. Create the user (email identity, no ThaID national ID) ─────
    console.log(`\n▶ Creating ${roleName} "${firstname} ${lastname}" <${email}> …`);
    const user = await users.createMember({ prefix, firstname, lastname, email });

    // ── 2. Approved work_history with the requested role ──────────────
    await workHistory.create(
      {
        userId: user.id,
        // Verified to exist above (env value or the '3001'/'3001027' default).
        amphoeId,
        localAdministrativeOrganizationId: laoId,
        roleId: role[0].id,
        workStatusId: approved[0].id,
      },
      user.id, // self-created (no prior admin exists)
    );

    // ── 3. Issue the initial credential (mustChange on login) ─────────
    // issueCredential always generates a RANDOM one-time password. If the
    // operator supplied SEED_ADMIN_PASSWORD, overwrite the stored hash with
    // that password instead (still mustChange=true → forced change + TOTP
    // enrol on first login, so a weak seed password is acceptable).
    const issued = await backupLogin.issueCredential(user.id, user.id);
    const customPassword = process.env.SEED_ADMIN_PASSWORD;
    let initialPassword = issued.plaintextPassword;
    if (customPassword) {
      const argon2 = app.get(Argon2Service, { strict: false });
      const dataSource2 = app.get(DataSource);
      const hash = await argon2.hash(customPassword);
      await dataSource2.query(
        'UPDATE backup_credentials SET password_hash = $2 WHERE user_id = $1',
        [user.id, hash],
      );
      initialPassword = customPassword;
    }

    console.log('\n✅ First admin created.\n');
    console.log('   ────────────────────────────────────────────');
    console.log(`   email               : ${email}`);
    console.log(`   initial password    : ${initialPassword}`);
    console.log(`   role                : ${roleName}`);
    console.log(`   userId              : ${user.id}`);
    console.log('   ────────────────────────────────────────────');
    console.log('\n   Next: log in at /login with the email + temporary password.');
    console.log('   You will be forced to change the password and enrol TOTP on');
    console.log('   first login. Store this password securely and delete it after.\n');
    return 0;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (msg.includes('EMAIL_ALREADY_EXISTS')) {
      console.error(`\n❌ An account with email "${email}" already exists. Use a different email.`);
    } else {
      console.error(`\n❌ Seed failed: ${msg}`);
    }
    return 1;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('❌ Unhandled error:', err);
    process.exit(1);
  });
