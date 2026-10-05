import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyPreferences, Preferences } from './preferences';
import { migrate } from './migrations';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: DatabaseSync;
  constructor() {
    const path = process.env.DATABASE_PATH || './data/invoices.sqlite';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        preferences TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL,
        payment_term TEXT NOT NULL, buyer_name TEXT NOT NULL, total REAL NOT NULL,
        payload TEXT NOT NULL, zip BLOB NOT NULL, created_at INTEGER NOT NULL,
        regenerated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS invoice_id_counter (
        id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO invoice_id_counter (id, value) SELECT 1, COALESCE(MAX(id), 0) FROM invoices;
      UPDATE invoice_id_counter SET value = MAX(value, (SELECT COALESCE(MAX(id), 0) FROM invoices)) WHERE id = 1;
      CREATE TABLE IF NOT EXISTS invoice_email_delivery (
        invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
        status TEXT NOT NULL, recipient TEXT NOT NULL, attempted_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS invoices_user_history ON invoices(user_id, id DESC);
    `);
    migrate(this.db);
  }
  preferences(id: number): Preferences {
    const row = this.db
      .prepare('SELECT preferences FROM users WHERE id = ?')
      .get(id)!;
    return {
      ...emptyPreferences(),
      ...(JSON.parse(row.preferences as string) as Preferences),
    };
  }
  updatePreferences(id: number, patch: Partial<Preferences>): Preferences {
    const next = { ...this.preferences(id), ...patch };
    this.db
      .prepare('UPDATE users SET preferences = ? WHERE id = ?')
      .run(JSON.stringify(next), id);
    return next;
  }
  onModuleDestroy() {
    this.db.close();
  }
}
