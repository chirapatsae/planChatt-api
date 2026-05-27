import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PASSWORD_CHANGE_REQUIRED_CODE } from '../constants/error-messages';

/**
 * SECURITY-01 §7.11 — forced-password-change gate.
 *
 * Blocks every backup endpoint EXCEPT the change-password endpoint
 * when the caller's JWT carries `requirePasswordChange = true`.
 *
 * Composed AFTER `JwtAuthGuard` so `req.user.requirePasswordChange`
 * is populated. This guard does NOT touch the DB — it relies on the
 * JWT claim set at issuance time (or refreshed via session-version
 * bump). The claim is the integrity contract; FE checks are
 * belt-and-suspenders.
 */
@Injectable()
export class RequirePasswordChangeNotPendingGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<{ user?: { requirePasswordChange?: boolean } }>();
    if (req?.user?.requirePasswordChange === true) {
      throw new ForbiddenException({
        code: PASSWORD_CHANGE_REQUIRED_CODE,
        message: 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งานระบบ',
      });
    }
    return true;
  }
}
