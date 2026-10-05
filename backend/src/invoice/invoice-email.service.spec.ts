import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import AdmZip from 'adm-zip';
import { Logger } from '@nestjs/common';
import { DatabaseService } from '../account/database.service';
import { InvoiceHistoryService } from './invoice-history.service';
import { InvoiceEmailService } from './invoice-email.service';

const keys = [
  'DATABASE_PATH',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_REQUIRE_TLS',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const accepted: SMTPTransport.SentMessageInfo = {
  accepted: ['owner@example.com'],
  rejected: [],
  pending: [],
  response: '250 accepted',
  messageId: 'test-message',
  envelope: { from: 'sender@gmail.com', to: ['owner@example.com'] },
};

describe('Invoice email delivery', () => {
  let database: DatabaseService;
  let history: InvoiceHistoryService;
  let email: InvoiceEmailService;
  let id: number;
  let zip: Buffer;
  const sendMail = jest.fn<
    Promise<SMTPTransport.SentMessageInfo>,
    [SendMailOptions]
  >();
  const user = { id: 1, email: 'owner@example.com' };
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_REQUIRE_TLS = 'true';
    process.env.SMTP_USER = 'sender@gmail.com';
    process.env.SMTP_PASS = 'test-app-password';
    process.env.MAIL_FROM = 'sender@gmail.com';
    sendMail.mockReset().mockResolvedValue(accepted);
    jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail, close: jest.fn() } as unknown as ReturnType<
        typeof nodemailer.createTransport
      >);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    database = new DatabaseService();
    database.db
      .prepare(
        'INSERT INTO users (id,email,password_hash,created_at,preferences) VALUES (1,?,?,?,?)',
      )
      .run(
        user.email,
        'test',
        Date.now(),
        JSON.stringify({
          seller: null,
          buyer: null,
          lastInvoiceNumber: null,
          savedItems: [],
        }),
      );
    history = new InvoiceHistoryService(database);
    const archive = new AdmZip();
    archive.addFile('invoice-SF-1-en.pdf', Buffer.from('%PDF-English'));
    archive.addFile('invoice-SF-1-lt.pdf', Buffer.from('%PDF-Lithuanian'));
    zip = archive.toBuffer();
    id = history.save(
      user.id,
      {
        invoiceNumber: 'SF 1',
        invoiceDate: '2026-10-03',
        paymentTerm: '2026-11-02',
        seller: {
          name: 'Seller',
          individualActivity: '',
          taxNumber: '',
          address: '',
          bankName: '',
          swift: '',
          iban: '',
        },
        buyer: { name: 'Buyer', vatCode: '', address: '' },
        items: [],
        additionalComment: '',
      },
      zip,
    );
    email = new InvoiceEmailService(database);
  });
  afterEach(() => {
    email.onModuleDestroy();
    database.onModuleDestroy();
    jest.restoreAllMocks();
    for (const key of keys)
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
  });
  it('uses Gmail TLS and attaches the exact retained PDFs to the account owner', async () => {
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        requireTLS: true,
        auth: { user: 'sender@gmail.com', pass: 'test-app-password' },
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    const result = await email.send(user, id, 'SF 1', zip);
    expect(result.status).toBe('sent');
    expect(typeof result.sentAt).toBe('number');
    const message = sendMail.mock.calls[0][0];
    expect(message.to).toEqual({ name: '', address: user.email });
    expect(message.attachments).toEqual([
      {
        filename: 'invoice-SF-1-en.pdf',
        content: Buffer.from('%PDF-English'),
        contentType: 'application/pdf',
      },
      {
        filename: 'invoice-SF-1-lt.pdf',
        content: Buffer.from('%PDF-Lithuanian'),
        contentType: 'application/pdf',
      },
    ]);
    expect(history.list(user.id).invoices[0].emailStatus).toBe('sent');
    expect(history.list(user.id).invoices[0].emailSentAt).toEqual(
      expect.any(Number),
    );
    const deliveries = history.versionDetails(user.id, id, 0).deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      status: 'sent',
      recipient: user.email,
      origin: 'observed',
      exactFilesAvailable: 1,
    });
    expect(
      history.downloadDelivery(user.id, id, 0, deliveries[0].id).zip,
    ).toEqual(zip);
    expect(
      database.db
        .prepare('SELECT status FROM invoice_delivery_events ORDER BY id')
        .all()
        .map((r) => r.status),
    ).toEqual(['pending', 'sent']);
    expect(() => history.downloadDelivery(2, id, 0, deliveries[0].id)).toThrow(
      'Invoice not found',
    );
    expect(() =>
      history.downloadDelivery(user.id, id, 1, deliveries[0].id),
    ).toThrow('not available');
  });
  it('reports missing credentials without breaking the retained invoice', async () => {
    delete process.env.MAIL_FROM;
    email = new InvoiceEmailService(database);
    expect(email.configured()).toBe(false);
    expect(await email.send(user, id, 'SF 1', zip)).toEqual({
      status: 'not_configured',
      sentAt: null,
    });
    expect(sendMail).not.toHaveBeenCalled();
    expect(history.download(user.id, id).zip).toEqual(zip);
    const delivery = history.versionDetails(user.id, id, 0).deliveries[0];
    expect(delivery).toMatchObject({
      status: 'not_configured',
      exactFilesAvailable: 0,
    });
    expect(() => history.downloadDelivery(user.id, id, 0, delivery.id)).toThrow(
      'not available',
    );
  });
  it('records SMTP failures and keeps documents available for later resend', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP authentication failed'));
    expect(await email.send(user, id, 'SF 1', zip)).toEqual({
      status: 'failed',
      sentAt: null,
    });
    expect(history.list(user.id).invoices[0].emailStatus).toBe('failed');
    expect(history.download(user.id, id).zip).toEqual(zip);
    database.db
      .prepare('UPDATE invoice_email_delivery SET attempted_at = 0')
      .run();
    expect((await email.send(user, id, 'SF 1', zip, true)).status).toBe('sent');
    expect(
      history.versionDetails(user.id, id, 0).deliveries.map((d) => d.status),
    ).toEqual(['sent', 'failed']);
    expect(
      database.db
        .prepare('SELECT COUNT(*) AS count FROM invoice_delivery_artifacts')
        .get()?.count,
    ).toBe(1);
  });
  it('treats rejected recipients as failure and rejects malformed PDF archives', async () => {
    sendMail.mockResolvedValueOnce({
      ...accepted,
      accepted: [],
      rejected: [user.email],
    });
    expect((await email.send(user, id, 'SF 1', zip)).status).toBe('failed');
    sendMail.mockClear();
    expect(
      (await email.send(user, id, 'SF 1', Buffer.from('not a ZIP'))).status,
    ).toBe('failed');
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('throttles manual resend and prevents simultaneous sends of the same invoice', async () => {
    await email.send(user, id, 'SF 1', zip);
    await expect(email.send(user, id, 'SF 1', zip, true)).rejects.toMatchObject(
      { status: 429 },
    );
    database.db
      .prepare('UPDATE invoice_email_delivery SET attempted_at = 0')
      .run();
    let finish!: (result: SMTPTransport.SentMessageInfo) => void;
    sendMail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = email.send(user, id, 'SF 1', zip, true);
    await expect(email.send(user, id, 'SF 1', zip, true)).rejects.toMatchObject(
      { status: 409 },
    );
    expect((await email.send(user, id, 'SF 1', zip)).status).toBe('pending');
    finish(accepted);
    await pending;
    expect(history.list(user.id).invoices[0].emailStatus).toBe('sent');
    expect(history.versionDetails(user.id, id, 0).deliveries).toHaveLength(2);
  });
  it('retains regenerated attachment bytes without creating a financial version, then preserves deliveries across edits and deletion', async () => {
    const regenerated = new AdmZip();
    regenerated.addFile(
      'invoice-en.pdf',
      Buffer.from('%PDF-regenerated-English'),
    );
    regenerated.addFile(
      'invoice-lt.pdf',
      Buffer.from('%PDF-regenerated-Lithuanian'),
    );
    const changedZip = regenerated.toBuffer();
    await email.send(user, id, 'SF 1', changedZip);
    const delivery = history.versionDetails(user.id, id, 0).deliveries[0];
    expect(history.downloadVersion(user.id, id, 0).zip).toEqual(zip);
    expect(history.downloadDelivery(user.id, id, 0, delivery.id).zip).toEqual(
      changedZip,
    );
    expect(history.versions(user.id, id).versions).toHaveLength(1);
    const current = history.details(user.id, id);
    history.update(
      user.id,
      id,
      0,
      { ...current.payload, additionalComment: 'Edited' },
      Buffer.from('edited'),
      'edited-delivery-key-01',
      'fingerprint',
    );
    expect(history.details(user.id, id).emailStatus).toBeNull();
    expect(history.versionDetails(user.id, id, 0).deliveries[0].status).toBe(
      'sent',
    );
    expect(history.versionDetails(user.id, id, 1).deliveries).toEqual([]);
    expect(() =>
      database.db.exec("UPDATE invoice_delivery_events SET status='failed'"),
    ).toThrow('immutable');
    expect(() =>
      database.db.exec('DELETE FROM invoice_delivery_events'),
    ).toThrow('Delete the invoice');
    expect(() =>
      database.db.exec(
        "UPDATE invoice_delivery_artifacts SET sha256='changed'",
      ),
    ).toThrow('immutable');
    expect(() =>
      database.db.exec('DELETE FROM invoice_delivery_artifacts'),
    ).toThrow('Delete the invoice');
    history.remove(user.id, id);
    for (const table of [
      'invoice_versions',
      'invoice_delivery_events',
      'invoice_delivery_artifacts',
    ]) {
      expect(
        database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
          ?.count,
      ).toBe(0);
    }
  });
});
