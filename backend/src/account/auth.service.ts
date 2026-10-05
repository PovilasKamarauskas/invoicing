import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from './database.service';
import { emptyPreferences, validatePreferences } from './preferences';

const hashPassword = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
export const sessionHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export interface AccountUser {
  id: number;
  email: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}
  private credentials(body: unknown, registration: boolean) {
    const input = body as { email?: unknown; password?: unknown } | null;
    if (typeof input?.email !== 'string' || typeof input.password !== 'string')
      throw new BadRequestException('Email and password are required.');
    const email = input.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException('Enter a valid email address.');
    if (
      input.password.length > 256 ||
      input.password.length < (registration ? 8 : 1)
    )
      throw new BadRequestException(
        'Password must be between 8 and 256 characters.',
      );
    return { email, password: input.password };
  }
  async register(body: unknown): Promise<AccountUser> {
    const { email, password } = this.credentials(body, true);
    const legacy = (body as { preferences?: unknown }).preferences;
    const preferences = {
      ...emptyPreferences(),
      ...(legacy === undefined ? {} : validatePreferences(legacy)),
    };
    const salt = randomBytes(16).toString('hex');
    const key = await hashPassword(password, salt);
    try {
      const result = this.database.db
        .prepare(
          'INSERT INTO users (email, password_hash, created_at, preferences) VALUES (?, ?, ?, ?)',
        )
        .run(
          email,
          `${salt}:${key.toString('hex')}`,
          Date.now(),
          JSON.stringify(preferences),
        );
      return { id: Number(result.lastInsertRowid), email };
    } catch (error) {
      if (
        this.database.db
          .prepare('SELECT id FROM users WHERE email = ?')
          .get(email)
      )
        throw new ConflictException(
          'An account with this email already exists. Please sign in.',
        );
      throw error;
    }
  }
  async login(body: unknown): Promise<AccountUser> {
    const { email, password } = this.credentials(body, false);
    const row = this.database.db
      .prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
      .get(email);
    const [salt, expected] = row
      ? (row.password_hash as string).split(':')
      : ['00000000000000000000000000000000', '00'.repeat(64)];
    const key = await hashPassword(password, salt);
    if (!row || !timingSafeEqual(key, Buffer.from(expected, 'hex')))
      throw new UnauthorizedException('Incorrect email or password.');
    return { id: Number(row.id), email: row.email as string };
  }
  createSession(user: AccountUser) {
    this.database.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(Date.now());
    const token = randomBytes(32).toString('hex');
    this.database.db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      )
      .run(sessionHash(token), user.id, Date.now() + SESSION_SECONDS * 1000);
    return token;
  }
  userForToken(token: string): AccountUser {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException('Please sign in.');
    const row = this.database.db
      .prepare(
        'SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?',
      )
      .get(sessionHash(token), Date.now());
    if (!row)
      throw new UnauthorizedException(
        'Your session has expired. Please sign in.',
      );
    return { id: Number(row.id), email: row.email as string };
  }
  logout(token: string) {
    this.database.db
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(sessionHash(token));
  }
}
