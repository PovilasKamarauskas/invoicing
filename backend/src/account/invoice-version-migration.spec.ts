import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations';

describe('Invoice version migration from deployed schema 4', () => {
  it('preserves exact current records, imports only a baseline and a qualified delivery observation, and reruns safely', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
        INSERT INTO schema_migrations VALUES (1,0),(2,0),(3,0),(4,0);
        CREATE TABLE users(id INTEGER PRIMARY KEY);
        INSERT INTO users VALUES(1);
        CREATE TABLE invoices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
          invoice_number TEXT,invoice_date TEXT,payment_term TEXT,buyer_name TEXT,total REAL,total_cents INTEGER,
          payload TEXT,calculation_version INTEGER,zip BLOB,created_at INTEGER,revision INTEGER,updated_at INTEGER);
        CREATE TABLE invoice_email_delivery(invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
          status TEXT,recipient TEXT,attempted_at INTEGER,sent_at INTEGER);
      `);
      db.prepare(
        'INSERT INTO invoices VALUES(1,1,?,?,?,?,?,?,?,?,?,?,3,?)',
      ).run(
        'SF 44',
        '2026-09-30',
        '2026-10-30',
        'Buyer',
        123.456,
        null,
        '{ "legacy": true }',
        0,
        Buffer.from([0, 255, 1, 2]),
        100,
        300,
      );
      db.prepare('INSERT INTO invoice_email_delivery VALUES(1,?,?,?,?)').run(
        'failed',
        'owner@example.invalid',
        500,
        200,
      );
      const before = db.prepare('SELECT * FROM invoices').all();
      migrate(db);
      expect(db.prepare('SELECT * FROM invoices').all()).toEqual(before);
      const version = db.prepare('SELECT * FROM invoice_versions').get()!;
      expect(version).toMatchObject({
        invoice_id: 1,
        revision: 3,
        origin: 'baseline',
        total: 123.456,
        total_cents: null,
        calculation_version: 0,
        payload: '{ "legacy": true }',
        created_at: 300,
      });
      expect(Buffer.from(version.zip as Uint8Array)).toEqual(
        Buffer.from([0, 255, 1, 2]),
      );
      expect(
        db.prepare('SELECT * FROM invoice_delivery_events').get(),
      ).toMatchObject({
        revision: 3,
        status: 'failed',
        origin: 'legacy_observation',
        artifact_id: null,
        attempted_at: 500,
        occurred_at: 500,
        sent_at: 200,
      });
      migrate(db);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM invoice_versions').get()
          ?.count,
      ).toBe(1);
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM invoice_delivery_events')
          .get()?.count,
      ).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe(
        'ok',
      );
    } finally {
      db.close();
    }
  });
});
