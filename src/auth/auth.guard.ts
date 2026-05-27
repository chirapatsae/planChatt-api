// jwt-auth.guard.ts
import {
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SESSION_INVALIDATED_CODE } from 'src/backup-login/constants/error-messages';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const secretKey = request.headers['secret-key'];
    if (!secretKey || secretKey !== process.env.LOGIN_SECRET) {
      throw new UnauthorizedException('Invalid secret key');
    }

    const result = (await super.canActivate(context)) as boolean;
    if (!result) return false;

    // Wave wave-backup-login-thaid-fallback / BE-01 (SECURITY-01 §7.7):
    // the `mfaChallengeToken` carries `purpose='backup-mfa-challenge'`
    // and MUST NEVER reach a `JwtAuthGuard`-protected endpoint. The
    // strategy propagates the `purpose` claim into `req.user`; we
    // reject it here.
    const user = request.user as
      | {
          userId?: string;
          purpose?: string;
          sessionVersion?: number;
        }
      | undefined;
    if (user?.purpose) {
      throw new UnauthorizedException('Invalid token purpose');
    }

    // Wave wave-backup-login-thaid-fallback / BE-01 (SECURITY-01 §7.8):
    // compare the JWT's `sessionVersion` against the live
    // `users.session_version`. Mismatch → 401 SESSION_INVALIDATED.
    if (user?.userId) {
      try {
        const rows: Array<{ session_version: number }> = await this.dataSource
          .query('SELECT session_version FROM users WHERE id = $1', [
            user.userId,
          ]);
        const live = rows[0]?.session_version ?? 0;
        const claimed = user.sessionVersion ?? 0;
        if (claimed < live) {
          throw new UnauthorizedException({
            code: SESSION_INVALIDATED_CODE,
            message: 'Session invalidated; please login again',
          });
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
        // DB read failure — log and proceed. Failing closed here would
        // wedge every authenticated request on a DB hiccup; the
        // session-version contract is invalidation-on-demand, not a
        // hot-path integrity check.
        this.logger.warn(
          `[JwtAuthGuard] session-version read failed: ${(err as Error).message}`,
        );
      }
    }

    return true;
  }

  handleRequest(err, user, info) {
    if (info?.name === 'TokenExpiredError') {
      throw new UnauthorizedException('Token has expired');
    }
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid credentials');
    }
    return user;
  }
}
