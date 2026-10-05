import type { DatabaseSync } from 'node:sqlite';

export function migrate(db: DatabaseSync) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  if (
    !db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
      ALTER TABLE invoices ADD COLUMN calculation_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE invoices ADD COLUMN total_cents INTEGER;
      CREATE TABLE issued_invoice_numbers (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invoice_number TEXT NOT NULL, request_key TEXT, state TEXT NOT NULL,
        PRIMARY KEY(user_id, invoice_number)
      );
      INSERT OR IGNORE INTO issued_invoice_numbers(user_id, invoice_number, state)
        SELECT user_id, TRIM(invoice_number), 'issued' FROM invoices;
      CREATE TABLE invoice_requests (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        invoice_number TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL,
        invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
        PRIMARY KEY(user_id, request_key)
      );
      CREATE TABLE invoice_sequences (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_number TEXT NOT NULL
      );
      INSERT INTO invoice_sequences(user_id,last_number)
        SELECT id, COALESCE(json_extract(preferences,'$.lastInvoiceNumber'), 'SF 0') FROM users;
    `);
      db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (
    !db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get()
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`DELETE FROM issued_invoice_numbers WHERE state = 'issued' AND NOT EXISTS (
        SELECT 1 FROM invoices WHERE invoices.user_id = issued_invoice_numbers.user_id
          AND TRIM(invoices.invoice_number) = issued_invoice_numbers.invoice_number
      )`);
      db.prepare('INSERT INTO schema_migrations VALUES (2, ?)').run(Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (
    !db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get()
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE tax_year_settings (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          year INTEGER NOT NULL, settings TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(user_id, year)
        );
        CREATE TABLE invoice_tax_metadata (
          invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
          earned_date TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX tax_earned_dates ON invoice_tax_metadata(earned_date);
        CREATE TABLE tax_entries (
          id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          year INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','GPM','VSD','PSD')),
          date TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents != 0),
          note TEXT NOT NULL, request_key TEXT NOT NULL, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, UNIQUE(user_id, request_key)
        );
        CREATE INDEX tax_entries_year ON tax_entries(user_id, year);
      `);
      db.prepare('INSERT INTO schema_migrations VALUES (3, ?)').run(Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (
    !db.prepare('SELECT version FROM schema_migrations WHERE version = 4').get()
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE invoices ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE invoices ADD COLUMN updated_at INTEGER;
        CREATE TABLE invoice_edit_requests (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
          invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL, PRIMARY KEY(user_id,request_key)
        );`);
      db.prepare('INSERT INTO schema_migrations VALUES (4, ?)').run(Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (
    !db.prepare('SELECT version FROM schema_migrations WHERE version = 5').get()
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE invoice_versions (
          invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK(revision >= 0),
          origin TEXT NOT NULL CHECK(origin IN ('baseline','generated','edited')),
          invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL, payment_term TEXT NOT NULL,
          buyer_name TEXT NOT NULL, total REAL NOT NULL, total_cents INTEGER,
          payload TEXT NOT NULL, calculation_version INTEGER NOT NULL,
          zip BLOB NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(invoice_id,revision)
        );
        INSERT INTO invoice_versions SELECT id,revision,'baseline',invoice_number,invoice_date,payment_term,
          buyer_name,total,total_cents,payload,calculation_version,zip,COALESCE(updated_at,created_at) FROM invoices;
        CREATE TABLE invoice_delivery_artifacts (
          id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          sha256 TEXT NOT NULL, zip BLOB NOT NULL, UNIQUE(invoice_id,sha256)
        );
        CREATE TABLE invoice_delivery_events (
          id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, revision INTEGER NOT NULL,
          attempt_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','not_configured')),
          recipient TEXT NOT NULL, attempted_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
          sent_at INTEGER, origin TEXT NOT NULL CHECK(origin IN ('observed','legacy_observation')),
          artifact_id INTEGER REFERENCES invoice_delivery_artifacts(id) ON DELETE CASCADE,
          FOREIGN KEY(invoice_id,revision) REFERENCES invoice_versions(invoice_id,revision) ON DELETE CASCADE
        );
        CREATE INDEX invoice_version_deliveries ON invoice_delivery_events(invoice_id,revision,id DESC);
        CREATE INDEX invoice_delivery_attempt_events ON invoice_delivery_events(invoice_id,attempt_id,id DESC);
        INSERT INTO invoice_delivery_events(invoice_id,revision,attempt_id,status,recipient,attempted_at,occurred_at,sent_at,origin)
          SELECT d.invoice_id,i.revision,'legacy-' || d.invoice_id,d.status,d.recipient,d.attempted_at,
            CASE WHEN d.status='sent' THEN COALESCE(d.sent_at,d.attempted_at) ELSE d.attempted_at END,d.sent_at,'legacy_observation'
          FROM invoice_email_delivery d JOIN invoices i ON i.id=d.invoice_id;
        CREATE TRIGGER immutable_invoice_version BEFORE UPDATE ON invoice_versions
          BEGIN SELECT RAISE(ABORT,'Invoice versions are immutable'); END;
        CREATE TRIGGER retain_invoice_version BEFORE DELETE ON invoice_versions
          WHEN EXISTS (SELECT 1 FROM invoices WHERE id=OLD.invoice_id)
          BEGIN SELECT RAISE(ABORT,'Delete the invoice to remove its versions'); END;
        CREATE TRIGGER immutable_delivery_event BEFORE UPDATE ON invoice_delivery_events
          BEGIN SELECT RAISE(ABORT,'Delivery history is immutable'); END;
        CREATE TRIGGER retain_delivery_event BEFORE DELETE ON invoice_delivery_events
          WHEN EXISTS (SELECT 1 FROM invoices WHERE id=OLD.invoice_id)
          BEGIN SELECT RAISE(ABORT,'Delete the invoice to remove delivery history'); END;
        CREATE TRIGGER immutable_delivery_artifact BEFORE UPDATE ON invoice_delivery_artifacts
          BEGIN SELECT RAISE(ABORT,'Delivery files are immutable'); END;
        CREATE TRIGGER retain_delivery_artifact BEFORE DELETE ON invoice_delivery_artifacts
          WHEN EXISTS (SELECT 1 FROM invoices WHERE id=OLD.invoice_id)
          BEGIN SELECT RAISE(ABORT,'Delete the invoice to remove delivery files'); END;
      `);
      db.prepare('INSERT INTO schema_migrations VALUES (5, ?)').run(Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
