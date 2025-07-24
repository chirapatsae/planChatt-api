// jwt-auth.guard.ts
import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];
    const secretKey = request.headers['secret-key'];
    if (!secretKey || secretKey !== process.env.LOGIN_SECRET) {
      throw new UnauthorizedException('Invalid secret key');
    }

    // ✅ call super and wait
    const result = await super.canActivate(context);
    return result as boolean;
  }

  handleRequest(err, user, info) {
    // if TokenExpiredError, return a more specific message
    if (info?.name === 'TokenExpiredError') {
      throw new UnauthorizedException('Token has expired');
    }
    if (err || !user) {
      // err: any other passport error
      throw err || new UnauthorizedException('Invalid credentials');
    }
    return user; // request.user = user
  }
}
