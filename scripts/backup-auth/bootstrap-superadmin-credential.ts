/**
 * Bootstrap CLI — issue the FIRST super-admin backup credential.
 *
 * Usage:
 *   NODE_ENV=development \
 *   npx ts-node -r tsconfig-paths/register \
 *     scripts/backup-auth/bootstrap-superadmin-credential.ts \
 *     --userId=<uuid> --confirm
 *
 * Guards:
 *   1. Rejects if any `backup_credentials` row already exists (this is
 *      a one-shot path; subsequent issuance uses
 *      `POST /v1/auth/backup-login/admin/issue` via the controller).
 *   2. Rejects unless target user has a current super-admin WorkHistory.
 *   3. Requires `--confirm` to proceed.
 *
 * The plaintext password is printed to stdout ONCE. The credential is
 * flagged `mustChangeOnNextLogin = true` and TOTP is initially absent
 * — the bootstrap user is the dual-bootstrap exemption (SECURITY-01
 * §11): first `/complete` skips TOTP, returns a JWT with
 * `requirePasswordChange: true` AND `requireTotpEnrollment: true`.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { BackupLoginService } from '../../src/backup-login/backup-login.service';
import { DataSource } from 'typeorm';

async function main() {
  const args = process.argv.slice(2);
  const userIdArg = args.find((a) => a.startsWith('--userId='));
  const confirm = args.includes('--confirm');

  if (!userIdArg) {
    console.error('Missing --userId=<uuid>');
    process.exit(1);
  }
  if (!confirm) {
    console.error('Refusing to run without --confirm');
    process.exit(1);
  }
  const userId = userIdArg.split('=')[1];
  if (!userId) {
    console.error('Empty --userId value');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule);
  const logger = new Logger('bootstrap-superadmin-credential');

  try {
    const ds = app.get(DataSource);

    const existing: Array<{ count: string }> = await ds.query(
      'SELECT COUNT(*)::text AS count FROM backup_credentials',
    );
    if (Number(existing[0]?.count ?? '0') > 0) {
      logger.error('Refusing to bootstrap: backup_credentials already has rows');
      process.exit(1);
    }

    const role: Array<{ rolename: string }> = await ds.query(
      `SELECT r.name AS rolename
         FROM work_history wh
         LEFT JOIN roles r ON r.id = wh.role_id
        WHERE wh.user_id = $1
          AND wh.is_current = TRUE
        LIMIT 1`,
      [userId],
    );
    if ((role[0]?.rolename ?? '') !== 'super-admin') {
      logger.error('Target user is not a current super-admin');
      process.exit(1);
    }

    const svc = app.get(BackupLoginService);
    const { plaintextPassword } = await svc.issueCredential(userId, userId);

    // Print exactly ONCE — wave brief requires single-emission.
    console.log('===========================================');
    console.log(' Bootstrap credential issued');
    console.log(` userId   : ${userId}`);
    console.log(` password : ${plaintextPassword}`);
    console.log(' (must be changed on first login)');
    console.log(' (must enroll TOTP on first login — bootstrap exemption)');
    console.log('===========================================');

    process.exit(0);
  } catch (err) {
    logger.error(`Bootstrap failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await app.close();
  }
}

main();
