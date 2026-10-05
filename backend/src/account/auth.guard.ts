import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccountUser, AuthService } from './auth.service';
import { allowedOrigins } from '../runtime-config';

export const Public = () => SetMetadata('public', true);
export type AccountRequest = Request & { user: AccountUser };
export function sessionToken(req: Request): string {
  const match = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('invoice_session='));
  return match?.slice('invoice_session='.length) || '';
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AccountRequest>();
    // A custom header cannot be sent by a cross-origin HTML form. Cross-site browser requests are rejected too.
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (req.headers['x-invoice-client'] !== 'web' ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin !== undefined &&
          !allowedOrigins().includes(req.headers.origin)))
    )
      throw new ForbiddenException('Invalid request origin.');
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    req.user = this.auth.userForToken(sessionToken(req));
    return true;
  }
}
