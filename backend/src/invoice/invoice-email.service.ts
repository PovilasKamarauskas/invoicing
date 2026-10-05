import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { createHash, randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { DatabaseService } from '../account/database.service';
import type { AccountUser } from '../account/auth.service';

export type EmailStatus = 'pending' | 'sent' | 'failed' | 'not_configured';
export interface EmailResult {
  status: EmailStatus;
  sentAt: number | null;
}

@Injectable()
export class InvoiceEmailService implements OnModuleDestroy {
  private readonly logger = new Logger(InvoiceEmailService.name);
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo> | null;
  private readonly inFlight = new Set<number>();
  constructor(private readonly database: DatabaseService) {
    const host = process.env.SMTP_HOST?.trim();
    const from = process.env.MAIL_FROM?.trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const ready =
      host &&
      from &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      !!user === !!pass;
    this.transporter = ready
      ? nodemailer.createTransport({
          host,
          port,
          secure:
            process.env.SMTP_SECURE === 'true' ||
            (process.env.SMTP_SECURE !== 'false' && port === 465),
          requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false',
          ...(user && pass ? { auth: { user, pass } } : {}),
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 20000,
          disableFileAccess: true,
          disableUrlAccess: true,
        })
      : null;
  }
  configured() {
    return this.transporter !== null;
  }
  private record(
    invoiceId: number,
    revision: number,
    attemptId: string,
    attemptedAt: number,
    status: EmailStatus,
    recipient: string,
    sentAt: number | null = null,
    zip?: Buffer,
    artifactId: number | null = null,
  ): number | null {
    const db = this.database.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (zip) {
        const hash = createHash('sha256').update(zip).digest('hex');
        db.prepare(
          'INSERT INTO invoice_delivery_artifacts(invoice_id,sha256,zip) VALUES (?,?,?) ON CONFLICT(invoice_id,sha256) DO NOTHING',
        ).run(invoiceId, hash, zip);
        artifactId = Number(
          db
            .prepare(
              'SELECT id FROM invoice_delivery_artifacts WHERE invoice_id=? AND sha256=?',
            )
            .get(invoiceId, hash)!.id,
        );
      }
      db.prepare(
        `INSERT INTO invoice_delivery_events(invoice_id,revision,attempt_id,status,recipient,attempted_at,occurred_at,sent_at,origin,artifact_id)
        VALUES (?,?,?,?,?,?,?,?,'observed',?)`,
      ).run(
        invoiceId,
        revision,
        attemptId,
        status,
        recipient,
        attemptedAt,
        Date.now(),
        sentAt,
        artifactId,
      );
      // Only the current revision may update the compatibility summary. Older attempts remain in immutable history.
      const current = db
        .prepare('SELECT revision FROM invoices WHERE id=?')
        .get(invoiceId);
      if (current?.revision === revision)
        db.prepare(
          `INSERT INTO invoice_email_delivery (invoice_id,status,recipient,attempted_at,sent_at) VALUES (?,?,?,?,?)
          ON CONFLICT(invoice_id) DO UPDATE SET status=excluded.status,recipient=excluded.recipient,attempted_at=excluded.attempted_at,sent_at=COALESCE(excluded.sent_at,invoice_email_delivery.sent_at)`,
        ).run(invoiceId, status, recipient, attemptedAt, sentAt);
      db.exec('COMMIT');
      return artifactId;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async send(
    user: AccountUser,
    invoiceId: number,
    invoiceNumber: string,
    zip: Buffer,
    manual = false,
  ): Promise<EmailResult> {
    const saved = this.database.db
      .prepare('SELECT revision FROM invoices WHERE id=? AND user_id=?')
      .get(invoiceId, user.id);
    if (!saved) throw new NotFoundException('Invoice not found.');
    const revision = Number(saved.revision);
    const attemptId = randomUUID();
    const attemptedAt = Date.now();
    if (!this.transporter) {
      this.record(
        invoiceId,
        revision,
        attemptId,
        attemptedAt,
        'not_configured',
        user.email,
      );
      return { status: 'not_configured', sentAt: null };
    }
    if (this.inFlight.has(invoiceId)) {
      if (manual)
        throw new ConflictException(
          'This invoice email is already being sent.',
        );
      return { status: 'pending', sentAt: null };
    }
    if (manual) {
      const previous = this.database.db
        .prepare(
          'SELECT status, attempted_at FROM invoice_email_delivery WHERE invoice_id = ?',
        )
        .get(invoiceId);
      if (
        previous &&
        Date.now() - Number(previous.attempted_at) <
          (previous.status === 'sent' ? 60000 : 5000)
      )
        throw new HttpException(
          'Please wait a moment before resending this invoice.',
          429,
        );
    }
    this.inFlight.add(invoiceId);
    let artifactId: number | null = null;
    try {
      const entries = new AdmZip(zip)
        .getEntries()
        .filter((entry) => !entry.isDirectory);
      if (
        entries.length !== 2 ||
        entries.some(
          (entry) =>
            !entry.entryName.endsWith('.pdf') ||
            entry.header.size > 20 * 1024 * 1024,
        )
      )
        throw new Error('Invalid invoice PDF archive.');
      const safeNumber = invoiceNumber.replace(/[^a-zA-Z0-9_.-]/g, '-');
      const attachments = entries.map((entry) => ({
        filename: entry.entryName.replace(/^.*[\\/]/, ''),
        content: entry.getData(),
        contentType: 'application/pdf',
      }));
      artifactId = this.record(
        invoiceId,
        revision,
        attemptId,
        attemptedAt,
        'pending',
        user.email,
        null,
        zip,
      );
      const info = await this.transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: { name: '', address: user.email },
        subject: `Invoice ${invoiceNumber.replace(/[\r\n]/g, ' ')}`,
        text: `Your invoice ${invoiceNumber} is attached in English and Lithuanian.\n\nYou can also download or regenerate it from Invoice history in your account.\n\nInvoice studio`,
        attachments,
        headers: { 'X-Invoice-Reference': safeNumber },
      });
      if (info.rejected.length || !info.accepted.length)
        throw new Error('Email recipient was rejected.');
      const sentAt = Date.now();
      this.record(
        invoiceId,
        revision,
        attemptId,
        attemptedAt,
        'sent',
        user.email,
        sentAt,
        undefined,
        artifactId,
      );
      return { status: 'sent', sentAt };
    } catch {
      this.logger.warn(
        `Email failed for invoice ${invoiceId}; saved documents remain available.`,
      );
      this.record(
        invoiceId,
        revision,
        attemptId,
        attemptedAt,
        'failed',
        user.email,
        null,
        undefined,
        artifactId,
      );
      return { status: 'failed', sentAt: null };
    } finally {
      this.inFlight.delete(invoiceId);
    }
  }
  onModuleDestroy() {
    this.transporter?.close();
  }
}
