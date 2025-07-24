// secret-key.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class SecretKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.headers['secret-key'];

    // Optional: Log the header for debug
    // console.log('[SecretKeyGuard] Received:', apiKey);

    if (apiKey !== process.env.LOGIN_SECRET) {
      throw new UnauthorizedException('Invalid secret key');
    }

    return true;
  }
}
