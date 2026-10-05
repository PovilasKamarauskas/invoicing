import {
  ConflictException,
  BadRequestException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import rules from '../../../shared/invoice-rules.cjs';
import { DatabaseService } from '../account/database.service';
import { GenerateInvoiceDto } from './invoice.dto';

export interface InvoiceSummary {
  id: number;
  invoiceNumber: string;
  invoiceDate: string;
  paymentTerm: string;
  buyerName: string;
  total: number;
  createdAt: number;
  revision: number;
  updatedAt: number | null;
  regeneratedAt: number | null;
  emailStatus: string | null;
  emailSentAt: number | null;
}
export interface InvoiceVersion {
  id: number;
  revision: number;
  origin: 'baseline' | 'generated' | 'edited';
  invoiceNumber: string;
  invoiceDate: string;
  paymentTerm: string;
  buyerName: string;
  total: number;
  createdAt: number;
  calculationVersion: number;
  emailStatus: string | null;
  emailSentAt: number | null;
}
export interface VersionDelivery {
  id: number;
  attemptId: string;
  status: string;
  recipient: string;
  attemptedAt: number;
  occurredAt: number;
  sentAt: number | null;
  origin: 'observed' | 'legacy_observation';
  exactFilesAvailable: number;
}
const VERSION = `invoice_id AS id, revision, origin, invoice_number AS invoiceNumber,
  invoice_date AS invoiceDate, payment_term AS paymentTerm, buyer_name AS buyerName,total,
  created_at AS createdAt, calculation_version AS calculationVersion,
  (SELECT status FROM invoice_delivery_events e WHERE e.invoice_id=v.invoice_id AND e.revision=v.revision ORDER BY e.id DESC LIMIT 1) AS emailStatus,
  (SELECT MAX(sent_at) FROM invoice_delivery_events e WHERE e.invoice_id=v.invoice_id AND e.revision=v.revision) AS emailSentAt`;
interface InvoiceRow extends InvoiceSummary {
  payload: string;
  calculationVersion: number;
  zip?: Uint8Array;
}
const SUMMARY = `id, invoice_number AS invoiceNumber, invoice_date AS invoiceDate,
  payment_term AS paymentTerm, buyer_name AS buyerName, total,
  revision, updated_at AS updatedAt, created_at AS createdAt, regenerated_at AS regeneratedAt,
  (SELECT status FROM invoice_email_delivery WHERE invoice_id = invoices.id) AS emailStatus,
  (SELECT sent_at FROM invoice_email_delivery WHERE invoice_id = invoices.id) AS emailSentAt`;

@Injectable()
export class InvoiceHistoryService {
  private readonly operations = new Set<number>();
  constructor(private readonly database: DatabaseService) {}
  async withOperation<T>(
    userId: number,
    id: number,
    work: () => Promise<T>,
  ): Promise<T> {
    this.get(userId, id);
    if (this.operations.has(id))
      throw new ConflictException('This invoice is already being processed.');
    this.operations.add(id);
    try {
      return await work();
    } finally {
      this.operations.delete(id);
    }
  }
  nextNumber(userId: number) {
    const rows = this.database.db
      .prepare(
        'SELECT invoice_number FROM invoices WHERE user_id = ? ORDER BY id DESC',
      )
      .all(userId);
    const numbered = rows.flatMap((row) => {
      const number = String(row.invoice_number).trim();
      const match = number.match(/^(.*?)(\d+)$/);
      return match
        ? [{ number, prefix: match[1], value: BigInt(match[2]) }]
        : [];
    });
    const sf = numbered.filter(
      (entry) => entry.prefix.trim().toUpperCase() === 'SF',
    );
    const series = sf.length
      ? sf
      : numbered.filter((entry) => entry.prefix === numbered[0]?.prefix);
    const highest = series.reduce<(typeof numbered)[number] | null>(
      (max, entry) => (!max || entry.value > max.value ? entry : max),
      null,
    );
    let number = rules.nextNumber(highest?.number || null);
    // Pending generation in another tab also reserves a number.
    while (
      this.database.db
        .prepare(
          'SELECT 1 FROM issued_invoice_numbers WHERE user_id = ? AND invoice_number = ?',
        )
        .get(userId, number)
    )
      number = rules.nextNumber(number);
    return number;
  }

  begin(
    userId: number,
    key: string,
    fingerprint: string,
    payload: GenerateInvoiceDto,
  ) {
    const db = this.database.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Rendering is bounded well below this lease. Expired reservations can be retried after a crash.
      db.prepare(
        "DELETE FROM issued_invoice_numbers WHERE state = 'pending' AND (user_id,request_key) IN (SELECT user_id,request_key FROM invoice_requests WHERE state = 'pending' AND started_at < ?)",
      ).run(Date.now() - 300000);
      db.prepare(
        "UPDATE invoice_requests SET state = 'failed' WHERE state = 'pending' AND started_at < ?",
      ).run(Date.now() - 300000);
      const existing = db
        .prepare(
          'SELECT * FROM invoice_requests WHERE user_id = ? AND request_key = ?',
        )
        .get(userId, key);
      if (existing && existing.fingerprint !== fingerprint)
        throw new ConflictException(
          'This request was already used for different invoice details.',
        );
      if (existing?.state === 'saved') {
        if (!existing.invoice_id)
          throw new GoneException(
            'This invoice was deleted. Start a new invoice.',
          );
        const saved = this.download(userId, Number(existing.invoice_id));
        const emailStatus = this.details(
          userId,
          Number(existing.invoice_id),
        ).emailStatus;
        db.exec('COMMIT');
        return {
          replay: {
            ...saved,
            id: Number(existing.invoice_id),
            emailStatus,
          },
          payload,
        };
      }
      if (existing?.state === 'pending')
        throw new ConflictException(
          'This invoice is still generating. Please retry shortly.',
        );
      const invoiceNumber = payload.autoNumber
        ? this.nextNumber(userId)
        : payload.invoiceNumber.trim();
      if (invoiceNumber.length > 100 || /[\r\n"/\\]/.test(invoiceNumber))
        throw new BadRequestException(
          'Choose a valid invoice number or numbering prefix.',
        );
      if (
        db
          .prepare(
            'SELECT 1 FROM issued_invoice_numbers WHERE user_id = ? AND invoice_number = ?',
          )
          .get(userId, invoiceNumber)
      )
        throw new ConflictException(
          'This invoice number has already been used. Download it from history or choose a new number.',
        );
      db.prepare(
        "INSERT INTO issued_invoice_numbers VALUES (?, ?, ?, 'pending')",
      ).run(userId, invoiceNumber, key);
      db.prepare(
        "INSERT INTO invoice_requests(user_id,request_key,fingerprint,invoice_number,state,started_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT(user_id,request_key) DO UPDATE SET invoice_number=excluded.invoice_number,state='pending',started_at=excluded.started_at",
      ).run(userId, key, fingerprint, invoiceNumber, Date.now());
      db.exec('COMMIT');
      return {
        replay: null,
        payload: { ...payload, invoiceNumber, calculationVersion: 1 },
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  fail(userId: number, key: string) {
    const db = this.database.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        "DELETE FROM issued_invoice_numbers WHERE user_id = ? AND request_key = ? AND state = 'pending'",
      ).run(userId, key);
      db.prepare(
        "UPDATE invoice_requests SET state = 'failed' WHERE user_id = ? AND request_key = ? AND state = 'pending'",
      ).run(userId, key);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  list(userId: number, before?: number) {
    const rows = this.database.db
      .prepare(
        `SELECT ${SUMMARY} FROM invoices WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 51`,
      )
      .all(
        userId,
        before || Number.MAX_SAFE_INTEGER,
      ) as unknown as InvoiceSummary[];
    const invoices = rows.slice(0, 50);
    return {
      invoices,
      nextCursor: rows.length > 50 ? invoices[invoices.length - 1].id : null,
    };
  }
  private get(userId: number, id: number, includeZip = false): InvoiceRow {
    const row = this.database.db
      .prepare(
        `SELECT ${SUMMARY}, payload, calculation_version AS calculationVersion${includeZip ? ', zip' : ''} FROM invoices WHERE user_id = ? AND id = ?`,
      )
      .get(userId, id) as unknown as InvoiceRow | undefined;
    if (!row) throw new NotFoundException('Invoice not found.');
    return row;
  }
  details(userId: number, id: number) {
    const { payload, calculationVersion, ...summary } = this.get(userId, id);
    return {
      ...summary,
      payload: {
        ...(JSON.parse(payload) as GenerateInvoiceDto),
        calculationVersion,
      },
    };
  }
  download(userId: number, id: number) {
    const row = this.get(userId, id, true);
    return { invoiceNumber: row.invoiceNumber, zip: Buffer.from(row.zip!) };
  }
  private snapshot(id: number, origin: 'generated' | 'edited') {
    this.database.db
      .prepare(
        `INSERT INTO invoice_versions
      SELECT id,revision,?,invoice_number,invoice_date,payment_term,buyer_name,total,total_cents,
        payload,calculation_version,zip,COALESCE(updated_at,created_at) FROM invoices WHERE id=?`,
      )
      .run(origin, id);
  }
  versions(userId: number, id: number, before?: number) {
    const currentRevision = this.get(userId, id).revision;
    const rows = this.database.db
      .prepare(
        `SELECT ${VERSION} FROM invoice_versions v WHERE invoice_id=? AND revision<? ORDER BY revision DESC LIMIT 51`,
      )
      .all(
        id,
        before ?? Number.MAX_SAFE_INTEGER,
      ) as unknown as InvoiceVersion[];
    return {
      currentRevision,
      versions: rows.slice(0, 50),
      nextRevision: rows.length > 50 ? rows[49].revision : null,
    };
  }
  versionDetails(userId: number, id: number, revision: number) {
    this.get(userId, id);
    const row = this.database.db
      .prepare(
        `SELECT ${VERSION},payload FROM invoice_versions v WHERE invoice_id=? AND revision=?`,
      )
      .get(id, revision) as unknown as
      (InvoiceVersion & { payload: string }) | undefined;
    if (!row) throw new NotFoundException('Invoice version not found.');
    const { payload, ...summary } = row;
    const deliveries = this.database.db
      .prepare(
        `SELECT e.id,attempt_id AS attemptId,status,recipient,
      attempted_at AS attemptedAt,occurred_at AS occurredAt,sent_at AS sentAt,origin,
      (artifact_id IS NOT NULL) AS exactFilesAvailable FROM invoice_delivery_events e
      WHERE invoice_id=? AND revision=? AND NOT EXISTS (
        SELECT 1 FROM invoice_delivery_events later WHERE later.invoice_id=e.invoice_id AND later.attempt_id=e.attempt_id AND later.id>e.id)
      ORDER BY e.id DESC`,
      )
      .all(id, revision) as unknown as VersionDelivery[];
    return {
      ...summary,
      payload: {
        ...(JSON.parse(payload) as GenerateInvoiceDto),
        calculationVersion: row.calculationVersion,
      },
      deliveries,
    };
  }
  downloadVersion(userId: number, id: number, revision: number) {
    this.get(userId, id);
    const row = this.database.db
      .prepare(
        'SELECT invoice_number,zip FROM invoice_versions WHERE invoice_id=? AND revision=?',
      )
      .get(id, revision);
    if (!row) throw new NotFoundException('Invoice version not found.');
    return {
      invoiceNumber: String(row.invoice_number),
      zip: Buffer.from(row.zip as Uint8Array),
    };
  }
  downloadDelivery(
    userId: number,
    id: number,
    revision: number,
    deliveryId: number,
  ) {
    this.get(userId, id);
    const row = this.database.db
      .prepare(
        `SELECT v.invoice_number,a.zip FROM invoice_delivery_events e
      JOIN invoice_versions v ON v.invoice_id=e.invoice_id AND v.revision=e.revision
      JOIN invoice_delivery_artifacts a ON a.id=e.artifact_id AND a.invoice_id=e.invoice_id
      WHERE e.invoice_id=? AND e.revision=? AND e.id=?`,
      )
      .get(id, revision, deliveryId);
    if (!row) throw new NotFoundException('Delivery files are not available.');
    return {
      invoiceNumber: String(row.invoice_number),
      zip: Buffer.from(row.zip as Uint8Array),
    };
  }
  save(
    userId: number,
    payload: GenerateInvoiceDto,
    zip: Buffer,
    requestKey?: string,
  ): number {
    this.database.db.exec('BEGIN IMMEDIATE');
    try {
      const invoiceNumber = payload.invoiceNumber.trim();
      const claim = this.database.db
        .prepare(
          'SELECT * FROM issued_invoice_numbers WHERE user_id = ? AND invoice_number = ?',
        )
        .get(userId, invoiceNumber);
      if (
        claim &&
        (!requestKey ||
          claim.request_key !== requestKey ||
          claim.state !== 'pending')
      )
        throw new ConflictException(
          'This invoice number has already been used.',
        );
      if (requestKey && !claim)
        throw new ConflictException(
          'The invoice reservation expired. Please retry.',
        );
      const amounts = rules.calculate(
        payload.items,
        payload.calculationVersion ?? 1,
      );
      const total = amounts.total;
      const counter = this.database.db
        .prepare(
          'UPDATE invoice_id_counter SET value = value + 1 WHERE id = 1 RETURNING value',
        )
        .get()!;
      const id = Number(counter.value);
      this.database.db
        .prepare(
          `INSERT INTO invoices (id, user_id, invoice_number, invoice_date, payment_term, buyer_name, total, payload, zip, created_at, calculation_version, total_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          userId,
          invoiceNumber,
          payload.invoiceDate,
          payload.paymentTerm,
          payload.buyer.name,
          total,
          JSON.stringify(payload),
          zip,
          Date.now(),
          payload.calculationVersion ?? 1,
          amounts.totalCents ?? null,
        );
      this.snapshot(id, 'generated');
      this.database.db
        .prepare(
          "INSERT INTO issued_invoice_numbers(user_id,invoice_number,state) VALUES (?, ?, 'issued') ON CONFLICT(user_id,invoice_number) DO UPDATE SET state='issued'",
        )
        .run(userId, invoiceNumber);
      if (requestKey)
        this.database.db
          .prepare(
            "UPDATE invoice_requests SET state = 'saved', invoice_id = ? WHERE user_id = ? AND request_key = ?",
          )
          .run(id, userId, requestKey);
      const sequence = this.database.db
        .prepare('SELECT last_number FROM invoice_sequences WHERE user_id = ?')
        .get(userId);
      const oldNumber = sequence
        ? String(sequence.last_number)
        : this.database.preferences(userId).lastInvoiceNumber;
      const oldMatch = oldNumber?.match(/^(.*?)(\d+)$/);
      const newMatch = invoiceNumber.match(/^(.*?)(\d+)$/);
      const lastNumber =
        oldMatch &&
        newMatch &&
        oldMatch[1] === newMatch[1] &&
        BigInt(oldMatch[2]) > BigInt(newMatch[2])
          ? oldNumber!
          : invoiceNumber;
      this.database.db
        .prepare(
          'INSERT INTO invoice_sequences VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_number=excluded.last_number',
        )
        .run(userId, lastNumber);
      this.database.updatePreferences(userId, {
        lastInvoiceNumber: lastNumber,
        buyer: { ...payload.buyer },
      });
      this.database.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.database.db.exec('ROLLBACK');
      throw error;
    }
  }
  remove(userId: number, id: number) {
    this.get(userId, id);
    if (this.operations.has(id))
      throw new ConflictException(
        'This invoice is being processed. Please wait before deleting it.',
      );
    const saved = this.get(userId, id);
    const db = this.database.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM invoices WHERE user_id = ? AND id = ?').run(
        userId,
        id,
      );
      db.prepare(
        `DELETE FROM issued_invoice_numbers WHERE user_id = ? AND invoice_number = ? AND state = 'issued'
        AND NOT EXISTS (SELECT 1 FROM invoices WHERE user_id = ? AND TRIM(invoice_number) = ?)`,
      ).run(
        userId,
        saved.invoiceNumber.trim(),
        userId,
        saved.invoiceNumber.trim(),
      );
      db.exec('COMMIT');
      return { deleted: true, id };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  checkEdit(
    userId: number,
    id: number,
    revision: number,
    number: string,
    key: string,
    fingerprint: string,
  ) {
    const saved = this.get(userId, id);
    const previous = this.database.db
      .prepare(
        'SELECT * FROM invoice_edit_requests WHERE user_id=? AND request_key=?',
      )
      .get(userId, key);
    if (previous) {
      if (
        previous.fingerprint !== fingerprint ||
        previous.invoice_id !== id ||
        previous.revision !== saved.revision
      )
        throw new ConflictException(
          'This edit was already used or the invoice changed. Reload the invoice before editing.',
        );
      return true;
    }
    if (saved.revision !== revision)
      throw new ConflictException(
        'This invoice changed in another session. Reload it before editing.',
      );
    if (!number || number.length > 100 || /[\r\n"/\\]/.test(number))
      throw new BadRequestException('Choose a valid invoice number.');
    const other = this.database.db
      .prepare(
        'SELECT id FROM invoices WHERE user_id=? AND TRIM(invoice_number)=? AND id!=?',
      )
      .get(userId, number, id);
    const claim = this.database.db
      .prepare(
        'SELECT state FROM issued_invoice_numbers WHERE user_id=? AND invoice_number=?',
      )
      .get(userId, number);
    if (
      other ||
      (claim &&
        (number !== saved.invoiceNumber.trim() || claim.state !== 'issued'))
    )
      throw new ConflictException(
        'This invoice number has already been used or reserved.',
      );
    return false;
  }
  update(
    userId: number,
    id: number,
    revision: number,
    payload: GenerateInvoiceDto,
    zip: Buffer,
    key: string,
    fingerprint: string,
  ) {
    const db = this.database.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (
        this.checkEdit(
          userId,
          id,
          revision,
          payload.invoiceNumber,
          key,
          fingerprint,
        )
      ) {
        db.exec('COMMIT');
        return;
      }
      const old = this.get(userId, id);
      const amounts = rules.calculate(payload.items, 1);
      db.prepare(
        `UPDATE invoices SET invoice_number=?,invoice_date=?,payment_term=?,buyer_name=?,total=?,total_cents=?,payload=?,zip=?,calculation_version=1,revision=revision+1,updated_at=?,regenerated_at=? WHERE user_id=? AND id=?`,
      ).run(
        payload.invoiceNumber,
        payload.invoiceDate,
        payload.paymentTerm,
        payload.buyer.name,
        amounts.total,
        amounts.totalCents!,
        JSON.stringify(payload),
        zip,
        Date.now(),
        Date.now(),
        userId,
        id,
      );
      db.prepare(
        "INSERT INTO issued_invoice_numbers(user_id,invoice_number,state) VALUES (?,?,'issued') ON CONFLICT(user_id,invoice_number) DO UPDATE SET state='issued'",
      ).run(userId, payload.invoiceNumber);
      if (old.invoiceNumber.trim() !== payload.invoiceNumber)
        db.prepare(
          "DELETE FROM issued_invoice_numbers WHERE user_id=? AND invoice_number=? AND state='issued' AND NOT EXISTS (SELECT 1 FROM invoices WHERE user_id=? AND TRIM(invoice_number)=?)",
        ).run(
          userId,
          old.invoiceNumber.trim(),
          userId,
          old.invoiceNumber.trim(),
        );
      this.snapshot(id, 'edited');
      db.prepare('DELETE FROM invoice_email_delivery WHERE invoice_id=?').run(
        id,
      );
      db.prepare('INSERT INTO invoice_edit_requests VALUES (?,?,?,?,?)').run(
        userId,
        key,
        fingerprint,
        id,
        revision + 1,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  markRegenerated(userId: number, id: number) {
    const result = this.database.db
      .prepare(
        'UPDATE invoices SET regenerated_at = ? WHERE user_id = ? AND id = ?',
      )
      .run(Date.now(), userId, id);
    if (!result.changes) throw new NotFoundException('Invoice not found.');
  }
}
