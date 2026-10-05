import type { IncomingMessage, Server } from 'node:http';
import type { Preferences } from './preferences';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../app.module';
import { DatabaseService } from './database.service';
import { InvoiceEmailService } from '../invoice/invoice-email.service';
import { InvoiceHistoryService } from '../invoice/invoice-history.service';
import type { GenerateInvoiceDto } from '../invoice/invoice.dto';
import type { InvoiceSummary } from '../invoice/invoice-history.service';
import { InvoiceService } from '../invoice/invoice.service';

const seller = {
  name: 'Seller',
  individualActivity: '',
  taxNumber: '',
  address: '',
  bankName: '',
  swift: '',
  iban: '',
};
const buyer = { name: 'Buyer', vatCode: '', address: '' };

const binary = (
  response: IncomingMessage,
  callback: (error: Error | null, body?: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', (error: Error) => callback(error));
};

describe('Accounts and SQLite persistence', () => {
  let app: INestApplication<Server>;
  let database: DatabaseService;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  const directory = mkdtempSync(join(tmpdir(), 'invoice-accounts-'));
  const oldPath = process.env.DATABASE_PATH;
  const generate = jest
    .fn<Promise<Buffer>, [GenerateInvoiceDto]>()
    .mockResolvedValue(Buffer.from('test-zip'));
  beforeAll(async () => {
    process.env.DATABASE_PATH = join(directory, 'test.sqlite');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(InvoiceService)
      .useValue({ generate })
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    await app.init();
    database = module.get(DatabaseService);
    alice = request.agent(app.getHttpServer());
    bob = request.agent(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    if (oldPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = oldPath;
  });
  it('protects account data and generation; rejects mutations without the client header', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    await request(app.getHttpServer())
      .post('/invoice/generate')
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(401);
    await alice
      .post('/api/auth/register')
      .send({ email: 'alice@example.com', password: 'password-123' })
      .expect(403);
    await alice
      .post('/api/auth/register')
      .set('X-Invoice-Client', 'web')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ email: 'alice@example.com', password: 'password-123' })
      .expect(403);
  });
  it('validates credentials and registers with an HttpOnly cookie and hashed password', async () => {
    await alice
      .post('/api/auth/register')
      .set('X-Invoice-Client', 'web')
      .send({ email: 'alice@example.com', password: 'short' })
      .expect(400);
    const result = await alice
      .post('/api/auth/register')
      .set('X-Invoice-Client', 'web')
      .send({
        email: ' ALICE@example.com ',
        password: 'password-123',
        preferences: { savedItems: ['Overtime'], seller },
      })
      .expect(201);
    expect((result.body as { user: { email: string } }).user.email).toBe(
      'alice@example.com',
    );
    expect(result.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(result.headers['set-cookie'][0]).toMatch(/SameSite=Lax/);
    expect(result.body).not.toHaveProperty('password_hash');
    const row = database.db
      .prepare('SELECT password_hash FROM users WHERE email = ?')
      .get('alice@example.com')!;
    expect(row.password_hash).not.toContain('password-123');
    await bob
      .post('/api/auth/register')
      .set('X-Invoice-Client', 'web')
      .send({ email: 'Alice@example.com', password: 'password-123' })
      .expect(409);
    await bob
      .post('/api/auth/register')
      .set('X-Invoice-Client', 'web')
      .send({ email: 'bob@example.com', password: 'password-456' })
      .expect(201);
  });
  it('keeps saved items and preferences isolated by account and deduplicates saved items', async () => {
    const result = await alice
      .post('/api/saved-items')
      .set('X-Invoice-Client', 'web')
      .send({ description: ' overtime ' })
      .expect(201);
    expect(result.body).toEqual(['Overtime']);
    await alice
      .put('/api/preferences')
      .set('X-Invoice-Client', 'web')
      .send({ buyer })
      .expect(200);
    await alice
      .put('/api/preferences')
      .set('X-Invoice-Client', 'web')
      .send({ savedItems: [123] })
      .expect(400);
    await alice
      .put('/api/preferences')
      .set('X-Invoice-Client', 'web')
      .send({ userId: 2 })
      .expect(400);
    const own = await alice.get('/api/auth/me').expect(200);
    expect(
      (own.body as { preferences: Preferences }).preferences.buyer,
    ).toEqual(buyer);
    expect(
      (own.body as { preferences: Preferences }).preferences.seller,
    ).toEqual(seller);
    const other = await bob.get('/api/auth/me').expect(200);
    expect((other.body as { preferences: Preferences }).preferences).toEqual({
      seller: null,
      buyer: null,
      savedItems: [],
      lastInvoiceNumber: null,
    });
    const secondConnection = new DatabaseService();
    expect(
      secondConnection.preferences(
        (own.body as { user: { id: number } }).user.id,
      ).savedItems,
    ).toEqual(['Overtime']);
    secondConnection.onModuleDestroy();
  });
  it('revokes logout sessions, checks passwords, and restores the saved account on login', async () => {
    await alice
      .post('/api/auth/logout')
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(201);
    await alice.get('/api/auth/me').expect(401);
    await alice
      .post('/api/auth/login')
      .set('X-Invoice-Client', 'web')
      .send({ email: 'alice@example.com', password: 'wrong-password' })
      .expect(401);
    const result = await alice
      .post('/api/auth/login')
      .set('X-Invoice-Client', 'web')
      .send({ email: 'ALICE@example.com', password: 'password-123' })
      .expect(201);
    expect(
      (result.body as { preferences: Preferences }).preferences.savedItems,
    ).toEqual(['Overtime']);
  });
  it('validates invoice input and stores the number only after successful generation', async () => {
    await alice
      .post('/invoice/generate')
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(400);
    expect(generate).not.toHaveBeenCalled();
    const payload = {
      invoiceNumber: 'SF 7',
      invoiceDate: '2026-10-03',
      paymentTerm: '2026-11-02',
      seller,
      buyer,
      items: [{ description: 'Overtime', quantity: 2, unit: 'h', price: 100 }],
      additionalComment: 'Reverse charge',
    };
    await alice
      .post('/invoice/generate')
      .set('X-Invoice-Client', 'web')
      .send(payload)
      .expect(201);
    expect(
      ((await alice.get('/api/auth/me')).body as { preferences: Preferences })
        .preferences.lastInvoiceNumber,
    ).toBe('SF 7');
    generate.mockRejectedValueOnce(new Error('Renderer failed'));
    await alice
      .post('/invoice/generate')
      .set('X-Invoice-Client', 'web')
      .send({ ...payload, invoiceNumber: 'SF 8' })
      .expect(500);
    expect(
      ((await alice.get('/api/auth/me')).body as { preferences: Preferences })
        .preferences.lastInvoiceNumber,
    ).toBe('SF 7');
  });
  it('retains original invoice details/files and prevents access by other accounts', async () => {
    const list = await alice.get('/invoice/history').expect(200);
    const rows = (list.body as { invoices: InvoiceSummary[] }).invoices;
    expect(rows).toHaveLength(1);
    const id = rows[0].id;
    expect(rows[0].invoiceNumber).toBe('SF 7');
    expect(rows[0].total).toBe(200);
    const details = await alice.get(`/invoice/history/${id}`).expect(200);
    expect(
      (details.body as { payload: GenerateInvoiceDto }).payload.items[0]
        .description,
    ).toBe('Overtime');
    const files = await alice
      .get(`/invoice/history/${id}/download`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(files.body as Buffer).toEqual(Buffer.from('test-zip'));
    await bob.get(`/invoice/history/${id}`).expect(404);
    await bob.get(`/invoice/history/${id}/download`).expect(404);
    const calls = generate.mock.calls.length;
    await bob
      .post(`/invoice/history/${id}/regenerate`)
      .buffer(true)
      .parse(binary)
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(404);
    expect(generate.mock.calls.length).toBe(calls);
    expect((await bob.get('/invoice/history')).body as unknown).toEqual({
      invoices: [],
      nextCursor: null,
    });
    await request(app.getHttpServer()).get('/invoice/history').expect(401);
    await alice.get('/invoice/history?before=invalid').expect(400);
  });
  it('regenerates the saved snapshot without changing original files or numbering', async () => {
    const rows = (await alice.get('/invoice/history')).body as {
      invoices: InvoiceSummary[];
    };
    const id = rows.invoices[0].id;
    await alice
      .put('/api/preferences')
      .set('X-Invoice-Client', 'web')
      .send({
        lastInvoiceNumber: 'SF 20',
        seller: { ...seller, name: 'Changed seller' },
        buyer: { ...buyer, name: 'Changed buyer' },
      })
      .expect(200);
    generate.mockResolvedValueOnce(Buffer.from('regenerated-zip'));
    const result = await alice
      .post(`/invoice/history/${id}/regenerate`)
      .buffer(true)
      .parse(binary)
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(201);
    expect(result.body as Buffer).toEqual(Buffer.from('regenerated-zip'));
    const latest = generate.mock.calls[generate.mock.calls.length - 1][0];
    expect(latest.invoiceNumber).toBe('SF 7');
    expect(latest.seller.name).toBe('Seller');
    expect(latest.buyer.name).toBe('Buyer');
    const prefs = (await alice.get('/api/auth/me')).body as {
      preferences: Preferences;
    };
    expect(prefs.preferences.lastInvoiceNumber).toBe('SF 20');
    expect(prefs.preferences.buyer?.name).toBe('Changed buyer');
    expect(
      (
        await alice
          .get(`/invoice/history/${id}/download`)
          .buffer(true)
          .parse(binary)
      ).body as Buffer,
    ).toEqual(Buffer.from('test-zip'));
    const list = (await alice.get('/invoice/history')).body as {
      invoices: InvoiceSummary[];
    };
    expect(list.invoices).toHaveLength(1);
    expect(list.invoices[0].regeneratedAt).toEqual(expect.any(Number));
    const previousTime = list.invoices[0].regeneratedAt;
    generate.mockRejectedValueOnce(new Error('Renderer failed'));
    await alice
      .post(`/invoice/history/${id}/regenerate`)
      .buffer(true)
      .parse(binary)
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(500);
    expect(
      (
        (await alice.get('/invoice/history')).body as {
          invoices: InvoiceSummary[];
        }
      ).invoices[0].regeneratedAt,
    ).toBe(previousTime);
  });
  it('emails only the logged-in account address and rejects another account invoice', async () => {
    const rows = (await alice.get('/invoice/history')).body as {
      invoices: InvoiceSummary[];
    };
    const id = rows.invoices[0].id;
    const email = app.get(InvoiceEmailService);
    const send = jest
      .spyOn(email, 'send')
      .mockResolvedValue({ status: 'sent', sentAt: 1000 });
    const result = await alice
      .post(`/invoice/history/${id}/email`)
      .set('X-Invoice-Client', 'web')
      .send({ recipient: 'someone-else@example.com' })
      .expect(201);
    expect(result.body as unknown).toEqual({
      status: 'sent',
      sentAt: 1000,
      recipient: 'alice@example.com',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com' }),
      id,
      'SF 7',
      Buffer.from('test-zip'),
      true,
    );
    send.mockClear();
    await bob
      .post(`/invoice/history/${id}/email`)
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(404);
    expect(send).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post(`/invoice/history/${id}/email`)
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(401);
    send.mockRestore();
    await alice
      .post(`/invoice/history/${id}/email`)
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(503);
    const config = await alice.get('/invoice/email/config').expect(200);
    expect(config.body as unknown).toEqual({
      configured: false,
      recipient: 'alice@example.com',
    });
  });
  it('rolls back invoice retention if saving account preferences fails and paginates history', async () => {
    const history = app.get(InvoiceHistoryService);
    const user = (await alice.get('/api/auth/me')).body as {
      user: { id: number };
    };
    const before = history.list(user.user.id).invoices.length;
    const payload: GenerateInvoiceDto = {
      invoiceNumber: 'SF 21',
      invoiceDate: '2026-10-03',
      paymentTerm: '2026-11-02',
      seller,
      buyer,
      items: [],
      additionalComment: '',
    };
    const fail = jest
      .spyOn(database, 'updatePreferences')
      .mockImplementationOnce(() => {
        throw new Error('Storage failure');
      });
    expect(() =>
      history.save(user.user.id, payload, Buffer.from('zip')),
    ).toThrow('Storage failure');
    expect(history.list(user.user.id).invoices).toHaveLength(before);
    fail.mockRestore();
    for (let index = 0; index < 51; index++)
      history.save(
        user.user.id,
        { ...payload, invoiceNumber: `SF ${21 + index}` },
        Buffer.from('zip'),
      );
    const first = (await alice.get('/invoice/history')).body as {
      invoices: InvoiceSummary[];
      nextCursor: number;
    };
    expect(first.invoices).toHaveLength(50);
    const second = (
      await alice.get(`/invoice/history?before=${first.nextCursor}`)
    ).body as { invoices: InvoiceSummary[]; nextCursor: null };
    expect(second.invoices).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.invoices, ...second.invoices].map((row) => row.id))
        .size,
    ).toBe(52);
    const reopened = new DatabaseService();
    expect(
      reopened.db
        .prepare('SELECT COUNT(*) AS count FROM invoices WHERE user_id = ?')
        .get(user.user.id)?.count,
    ).toBe(52);
    reopened.onModuleDestroy();
  });
  it('deletes only owned invoices, cascades email history, and preserves numbering', async () => {
    const list = (await alice.get('/invoice/history')).body as {
      invoices: InvoiceSummary[];
    };
    const id = list.invoices[0].id;
    const prefsBefore = (await alice.get('/api/auth/me')).body as {
      preferences: Preferences;
    };
    database.db
      .prepare(
        'INSERT INTO invoice_email_delivery(invoice_id,status,recipient,attempted_at,sent_at) VALUES(?,?,?,?,?)',
      )
      .run(id, 'sent', 'alice@example.com', Date.now(), Date.now());
    await request(app.getHttpServer())
      .delete(`/invoice/history/${id}`)
      .set('X-Invoice-Client', 'web')
      .expect(401);
    await alice.delete(`/invoice/history/${id}`).expect(403);
    await bob
      .delete(`/invoice/history/${id}`)
      .set('X-Invoice-Client', 'web')
      .expect(404);
    await alice.get(`/invoice/history/${id}`).expect(200);
    const result = await alice
      .delete(`/invoice/history/${id}`)
      .set('X-Invoice-Client', 'web')
      .expect(200);
    expect(result.body as unknown).toEqual({ deleted: true, id });
    expect(
      database.db.prepare('SELECT id FROM invoices WHERE id = ?').get(id),
    ).toBeUndefined();
    expect(
      database.db
        .prepare(
          'SELECT invoice_id FROM invoice_email_delivery WHERE invoice_id = ?',
        )
        .get(id),
    ).toBeUndefined();
    await alice.get(`/invoice/history/${id}`).expect(404);
    await alice.get(`/invoice/history/${id}/download`).expect(404);
    await alice
      .post(`/invoice/history/${id}/regenerate`)
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(404);
    await alice
      .post(`/invoice/history/${id}/email`)
      .set('X-Invoice-Client', 'web')
      .send({})
      .expect(404);
    await alice
      .delete(`/invoice/history/${id}`)
      .set('X-Invoice-Client', 'web')
      .expect(404);
    expect(
      ((await alice.get('/api/auth/me')).body as { preferences: Preferences })
        .preferences,
    ).toEqual(prefsBefore.preferences);
    const newId = app.get(InvoiceHistoryService).save(
      ((await alice.get('/api/auth/me')).body as { user: { id: number } }).user
        .id,
      {
        invoiceNumber: 'SF 72',
        invoiceDate: '2026-10-03',
        paymentTerm: '2026-11-02',
        seller,
        buyer,
        items: [],
        additionalComment: '',
      },
      Buffer.from('new invoice'),
    );
    expect(newId).toBeGreaterThan(id);
    await alice.get(`/invoice/history/${id}`).expect(404);
  });
  it('rejects expired sessions and limits repeated authentication attempts', async () => {
    database.db.prepare('UPDATE sessions SET expires_at = 0').run();
    await alice.get('/api/auth/me').expect(401);
    let status = 0;
    for (let i = 0; i < 31; i++)
      status = (
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-Invoice-Client', 'web')
          .send({ email: 'invalid', password: 'x' })
      ).status;
    expect(status).toBe(429);
  });
});
