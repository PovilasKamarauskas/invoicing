import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from './../src/app.module';
import { DatabaseService } from '../src/account/database.service';
import { InvoiceHistoryService } from '../src/invoice/invoice-history.service';
import { InvoiceEmailService } from '../src/invoice/invoice-email.service';

describe('Application authentication (e2e)', () => {
  let app: INestApplication<Server>;
  const oldPath = process.env.DATABASE_PATH;
  const oldHost = process.env.SMTP_HOST;

  beforeAll(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.SMTP_HOST = '';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (oldPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = oldPath;
    if (oldHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = oldHost;
  });

  it('rejects access to account and invoice history without a session', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    await request(app.getHttpServer()).get('/invoice/history').expect(401);
    await request(app.getHttpServer())
      .get('/invoice/history/1/versions')
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/system/backup-status')
      .expect(401);
    await request(app.getHttpServer()).get('/api/taxes/2026').expect(401);
    await request(app.getHttpServer())
      .get('/api/taxes/2026/export')
      .expect(401);
  });

  it('rejects account mutations without the client header', () => {
    return request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'review@example.invalid', password: 'test-password' })
      .expect(403);
  });

  it('exposes owned version details and retained downloads through guarded, uncached routes', async () => {
    const client = request.agent(app.getHttpServer());
    const registered = await client
      .post('/api/auth/register')
      .set('X-Invoice-Client', 'web')
      .send({
        email: 'versions@example.invalid',
        password: 'disposable-test-password',
      })
      .expect(201);
    const user = (registered.body as { user: { id: number; email: string } })
      .user;
    const history = app.get(InvoiceHistoryService);
    const payload = {
      invoiceNumber: 'SF 1',
      invoiceDate: '2026-10-05',
      paymentTerm: '2026-11-05',
      seller: {
        name: 'Seller',
        address: '',
        individualActivity: '',
        taxNumber: '',
        bankName: '',
        swift: '',
        iban: '',
      },
      buyer: { name: 'Buyer', address: '', vatCode: '' },
      items: [{ description: 'Work', unit: 'd', quantity: 1, price: 100 }],
      additionalComment: 'Original',
    };
    const id = history.save(user.id, payload, Buffer.from('original-zip'));
    await app
      .get(InvoiceEmailService)
      .send(user, id, payload.invoiceNumber, Buffer.from('original-zip'));
    history.update(
      user.id,
      id,
      0,
      { ...payload, additionalComment: 'Edited' },
      Buffer.from('edited-zip'),
      'e2e-version-edit-key',
      'fingerprint',
    );
    const versions = await client
      .get(`/invoice/history/${id}/versions`)
      .expect(200);
    expect(versions.headers['cache-control']).toBe('no-store');
    expect(versions.body).toMatchObject({
      currentRevision: 1,
      nextRevision: null,
      versions: [
        { revision: 1, emailStatus: null },
        { revision: 0, emailStatus: 'not_configured' },
      ],
    });
    const detail = await client
      .get(`/invoice/history/${id}/versions/0`)
      .expect(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.body).toMatchObject({
      payload: { additionalComment: 'Original' },
      deliveries: [{ status: 'not_configured', exactFilesAvailable: 0 }],
    });
    const files = await client
      .get(`/invoice/history/${id}/versions/0/download`)
      .expect(200);
    expect(files.headers['cache-control']).toBe('no-store');
    expect(files.headers['content-disposition']).toContain('-v1.zip');
    await client.get(`/invoice/history/${id}/versions/-1`).expect(400);
    await client
      .get(`/invoice/history/${id}/versions?beforeRevision=-1`)
      .expect(400);
    await client.get(`/invoice/history/${id}/versions/2`).expect(404);
    await client
      .get(`/invoice/history/${id}/versions/0/deliveries/1/download`)
      .expect(404);
    const other = request.agent(app.getHttpServer());
    await other
      .post('/api/auth/register')
      .set('X-Invoice-Client', 'web')
      .send({
        email: 'other-versions@example.invalid',
        password: 'disposable-test-password',
      })
      .expect(201);
    for (const suffix of [
      'versions',
      'versions/0',
      'versions/0/download',
      'versions/0/deliveries/1/download',
    ]) {
      await other.get(`/invoice/history/${id}/${suffix}`).expect(404);
    }
  });

  it('persists account tax settings and reconciles income, payment and CSV through guarded APIs', async () => {
    const client = request.agent(app.getHttpServer());
    const registration = await client
      .post('/api/auth/register')
      .set('X-Invoice-Client', 'web')
      .send({
        email: 'tax-review@example.invalid',
        password: 'disposable-test-password',
      })
      .expect(201);
    const userId = (registration.body as { user: { id: number } }).user.id;
    app
      .get(DatabaseService)
      .db.prepare(
        "INSERT INTO invoices(user_id,invoice_number,invoice_date,payment_term,buyer_name,total,total_cents,payload,zip,created_at,calculation_version) VALUES (?,'SF 44','2026-01-31','2026-02-28','Test',30000,3000000,'{}',X'00',0,1)",
      )
      .run(userId);
    await client.put('/api/taxes/2026/settings').send({}).expect(403);
    await client
      .put('/api/taxes/2026/settings')
      .set('X-Invoice-Client', 'web')
      .send({
        profileConfirmed: true,
        onlyActivityIncome: 'yes',
        psdMonths: Array<boolean>(12).fill(true),
        psdReviewed: true,
        partialMonth: false,
      })
      .expect(200);
    const payment = {
      kind: 'PSD',
      date: '2027-01-01',
      amount: '965.76',
      note: 'Year covered: 2026',
      requestKey: 'test-request-key-00000001',
    };
    await client
      .post('/api/taxes/2026/entries')
      .set('X-Invoice-Client', 'web')
      .send(payment)
      .expect(201);
    await client
      .post('/api/taxes/2026/entries')
      .set('X-Invoice-Client', 'web')
      .send(payment)
      .expect(201);
    const result = await client.get('/api/taxes/2026').expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    const summary = result.body as {
      calculation: { net: number; monthlyAverage: number };
      balances: { PSD: number };
      entries: unknown[];
    };
    expect(summary.calculation.net).toBe(2512450);
    expect(summary.calculation.monthlyAverage).toBe(209371);
    expect(summary.balances.PSD).toBe(35346);
    expect(summary.entries).toHaveLength(1);
    const csv = await client.get('/api/taxes/2026/export').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('25124.50');
    await client.get('/api/taxes/not-a-year').expect(400);
  });
});
