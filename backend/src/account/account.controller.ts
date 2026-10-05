import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  ForbiddenException,
  HttpException,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AccountRequest } from './auth.guard';
import { Public, sessionToken } from './auth.guard';
import { AccountUser, AuthService, SESSION_SECONDS } from './auth.service';
import { DatabaseService } from './database.service';
import { canViewBackups } from '../system/backup.service';
import { text, validatePreferences } from './preferences';
import { registrationEnabled } from '../runtime-config';

@Controller('api')
export class AccountController {
  private readonly attempts = new Map<
    string,
    { count: number; expires: number }
  >();
  constructor(
    private readonly auth: AuthService,
    private readonly database: DatabaseService,
  ) {}
  private limit(req: AccountRequest) {
    const now = Date.now();
    for (const [key, value] of this.attempts)
      if (value.expires <= now) this.attempts.delete(key);
    const key = req.ip || 'unknown';
    const entry = this.attempts.get(key) || {
      count: 0,
      expires: now + 15 * 60 * 1000,
    };
    entry.count++;
    this.attempts.set(key, entry);
    if (entry.count > 30)
      throw new HttpException(
        'Too many sign-in attempts. Try again in 15 minutes.',
        429,
      );
  }
  private respond(user: AccountUser, req: AccountRequest, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    this.auth.logout(sessionToken(req));
    res.cookie('invoice_session', this.auth.createSession(user), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      path: '/',
      maxAge: SESSION_SECONDS * 1000,
    });
    return {
      user,
      preferences: this.database.preferences(user.id),
      capabilities: { backupStatus: canViewBackups(user.email) },
    };
  }
  @Public()
  @Post('auth/register')
  async register(
    @Body() body: unknown,
    @Req() req: AccountRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!registrationEnabled())
      throw new ForbiddenException('New account registration is disabled.');
    this.limit(req);
    return this.respond(await this.auth.register(body), req, res);
  }
  @Public()
  @Get('auth/config')
  @Header('Cache-Control', 'no-store')
  authConfig() {
    return { registrationEnabled: registrationEnabled() };
  }
  @Public()
  @Get('health')
  @Header('Cache-Control', 'no-store')
  health() {
    this.database.db.prepare('SELECT 1').get();
    return { status: 'ok' };
  }
  @Public()
  @Post('auth/login')
  async login(
    @Body() body: unknown,
    @Req() req: AccountRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.limit(req);
    return this.respond(await this.auth.login(body), req, res);
  }
  @Get('auth/me')
  me(@Req() req: AccountRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return {
      user: req.user,
      capabilities: { backupStatus: canViewBackups(req.user.email) },
      preferences: this.database.preferences(req.user.id),
    };
  }
  @Post('auth/logout')
  logout(
    @Req() req: AccountRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.auth.logout(sessionToken(req));
    res.clearCookie('invoice_session', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
    });
    return { ok: true };
  }
  @Put('preferences')
  preferences(@Body() body: unknown, @Req() req: AccountRequest) {
    return this.database.updatePreferences(
      req.user.id,
      validatePreferences(body),
    );
  }
  @Post('saved-items')
  saveItem(
    @Body() body: { description?: unknown },
    @Req() req: AccountRequest,
  ) {
    const description = text(body?.description, 500).trim();
    if (!description)
      throw new BadRequestException('Description cannot be empty.');
    const current = this.database.preferences(req.user.id);
    if (
      !current.savedItems.some(
        (item) => item.toLocaleLowerCase() === description.toLocaleLowerCase(),
      )
    ) {
      if (current.savedItems.length >= 500)
        throw new BadRequestException('Maximum 500 saved descriptions.');
      current.savedItems.push(description);
    }
    return this.database.updatePreferences(req.user.id, {
      savedItems: current.savedItems.sort((a, b) => a.localeCompare(b)),
    }).savedItems;
  }
}
