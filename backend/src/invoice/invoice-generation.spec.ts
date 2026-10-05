import { ConflictException, GoneException } from '@nestjs/common';
import type { Response } from 'express';
import type { AccountRequest } from '../account/auth.guard';
import { DatabaseService } from '../account/database.service';
import { InvoiceController } from './invoice.controller';
import { InvoiceHistoryService } from './invoice-history.service';
import { InvoiceEmailService } from './invoice-email.service';
import { InvoiceService } from './invoice.service';
import { TaxService } from '../tax/tax.service';
import type { GenerateInvoiceDto } from './invoice.dto';

const payload: GenerateInvoiceDto = {
  invoiceNumber: 'SF 001',
  invoiceDate: '2026-10-03',
  paymentTerm: '2026-11-02',
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
  items: [
    { description: 'Work', unit: 'h', price: 0.01, quantity: 0.5 },
    { description: 'Work', unit: 'h', price: 0.01, quantity: 0.5 },
  ],
  additionalComment: '',
};

describe('Invoice issuance and operation lifecycle', () => {
  let database: DatabaseService;
  let history: InvoiceHistoryService;
  let controller: InvoiceController;
  const oldPath = process.env.DATABASE_PATH;
  const generate = jest.fn<Promise<Buffer>, [GenerateInvoiceDto]>();
  const send = jest
    .fn()
    .mockResolvedValue({ status: 'not_configured', sentAt: null });
  const req = (key: string): AccountRequest =>
    ({
      headers: { 'idempotency-key': key },
      user: { id: 1, email: 'test@example.invalid' },
    }) as unknown as AccountRequest;
  const response = () =>
    ({
      setHeader: jest.fn(),
      set: jest.fn(),
      end: jest.fn(),
    }) as unknown as Response;
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    database = new DatabaseService();
    database.db
      .prepare('INSERT INTO users VALUES (1, ?, ?, ?, ?)')
      .run('test@example.invalid', 'unused', Date.now(), '{}');
    history = new InvoiceHistoryService(database);
    generate.mockReset().mockResolvedValue(Buffer.from('retained-zip'));
    send.mockClear();
    controller = new InvoiceController(
      { generate } as unknown as InvoiceService,
      history,
      { send } as unknown as InvoiceEmailService,
    );
  });
  afterEach(() => {
    database.onModuleDestroy();
    if (oldPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = oldPath;
  });
  it('returns the retained invoice on retry without another render or email', async () => {
    const key = 'retry-request-0001';
    await controller.generate(payload, req(key), response());
    const replay = response();
    await controller.generate(payload, req(key), replay);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    // This assertion inspects the mock; it does not invoke the Express method.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(replay.end).toHaveBeenCalledWith(Buffer.from('retained-zip'));
    expect(history.list(1).invoices).toHaveLength(1);
    expect(history.list(1).invoices[0].total).toBe(0.02);
    expect(
      history.versions(1, history.list(1).invoices[0].id).versions,
    ).toHaveLength(1);
    await expect(
      controller.generate(
        { ...payload, additionalComment: 'Changed' },
        req(key),
        response(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('reserves different server-assigned numbers for concurrent tabs', async () => {
    let finish!: (value: Buffer) => void;
    generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const auto = { ...payload, autoNumber: true };
    const first = controller.generate(
      auto,
      req('concurrent-tab-0001'),
      response(),
    );
    await expect(
      controller.generate(auto, req('concurrent-tab-0001'), response()),
    ).rejects.toBeInstanceOf(ConflictException);
    await controller.generate(auto, req('concurrent-tab-0002'), response());
    finish(Buffer.from('first-zip'));
    await first;
    expect(
      history
        .list(1)
        .invoices.map((i) => i.invoiceNumber)
        .sort(),
    ).toEqual(['SF 1', 'SF 2']);
    expect(history.nextNumber(1)).toBe('SF 3');
  });
  it('releases a deleted number for a new invoice without resurrecting the deleted retry', async () => {
    await controller.generate(payload, req('delete-request-0001'), response());
    const id = history.list(1).invoices[0].id;
    history.remove(1, id);
    await expect(
      controller.generate(payload, req('delete-request-0001'), response()),
    ).rejects.toBeInstanceOf(GoneException);
    expect(history.nextNumber(1)).toBe('SF 1');
    await controller.generate(payload, req('delete-request-0002'), response());
    expect(history.nextNumber(1)).toBe('SF 002');
  });
  it('suggests the highest SF number plus one and reuses the deleted highest number', () => {
    const id43 = history.save(
      1,
      { ...payload, invoiceNumber: 'SF 43' },
      Buffer.from('43'),
    );
    const id44 = history.save(
      1,
      { ...payload, invoiceNumber: 'SF 44' },
      Buffer.from('44'),
    );
    history.save(1, { ...payload, invoiceNumber: 'SF 12' }, Buffer.from('12'));
    expect(history.nextNumber(1)).toBe('SF 45');
    history.remove(1, id44);
    expect(history.nextNumber(1)).toBe('SF 44');
    history.save(
      1,
      { ...payload, invoiceNumber: 'SF 44' },
      Buffer.from('replacement'),
    );
    expect(history.nextNumber(1)).toBe('SF 45');
    expect(history.details(1, id43).invoiceNumber).toBe('SF 43');
  });
  it('releases failed reservations so the same operation can be retried', async () => {
    generate.mockRejectedValueOnce(new Error('Renderer failed'));
    await expect(
      controller.generate(payload, req('failure-request-0001'), response()),
    ).rejects.toThrow('Renderer failed');
    expect(history.list(1).invoices).toHaveLength(0);
    await controller.generate(payload, req('failure-request-0001'), response());
    expect(history.list(1).invoices).toHaveLength(1);
  });
  it('blocks deletion while regeneration is running and releases the lock afterwards', async () => {
    await controller.generate(
      payload,
      req('regenerate-request-01'),
      response(),
    );
    const id = history.list(1).invoices[0].id;
    let finish!: (value: Buffer) => void;
    generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = controller.regenerate(
      req('unused-request-key'),
      id,
      response(),
    );
    expect(() => history.remove(1, id)).toThrow(ConflictException);
    await expect(
      controller.regenerate(req('unused-request-key'), id, response()),
    ).rejects.toBeInstanceOf(ConflictException);
    finish(Buffer.from('regenerated-zip'));
    await operation;
    expect(history.download(1, id).zip).toEqual(Buffer.from('retained-zip'));
    expect(history.versions(1, id).versions).toHaveLength(1);
    history.remove(1, id);
    expect(history.list(1).invoices).toHaveLength(0);
  });
  it('updates the retained record and files once on retry, without emailing, and rejects stale edits', async () => {
    await controller.generate(
      payload,
      req('original-invoice-0001'),
      response(),
    );
    const id = history.list(1).invoices[0].id;
    const edit = {
      ...payload,
      invoiceNumber: 'SF 004',
      revision: 0,
      items: [
        { description: 'Updated work', unit: 'd', quantity: 10, price: 100 },
      ],
    };
    generate.mockResolvedValue(Buffer.from('updated-zip'));
    await controller.update(edit, req('edit-invoice-key-0001'), id, response());
    await controller.update(edit, req('edit-invoice-key-0001'), id, response());
    expect(generate).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(history.list(1).invoices).toHaveLength(1);
    expect(history.details(1, id)).toMatchObject({
      id,
      revision: 1,
      total: 1000,
      invoiceNumber: 'SF 004',
      emailStatus: null,
    });
    expect(history.download(1, id).zip).toEqual(Buffer.from('updated-zip'));
    expect(history.versions(1, id).versions.map((v) => v.revision)).toEqual([
      1, 0,
    ]);
    expect(history.downloadVersion(1, id, 0).zip).toEqual(
      Buffer.from('retained-zip'),
    );
    expect(history.nextNumber(1)).toBe('SF 005');
    await expect(
      controller.update(edit, req('stale-invoice-key-001'), id, response()),
    ).rejects.toBeInstanceOf(ConflictException);
    await controller.update(
      { ...edit, revision: 1, additionalComment: 'Second edit' },
      req('second-edit-key-0001'),
      id,
      response(),
    );
    await expect(
      controller.update(edit, req('edit-invoice-key-0001'), id, response()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(history.versions(1, id).versions.map((v) => v.revision)).toEqual([
      2, 1, 0,
    ]);
    expect(history.versionDetails(1, id, 2).payload.additionalComment).toBe(
      'Second edit',
    );
    expect(history.versionDetails(1, id, 0).total).toBe(0.02);
    expect(new TaxService(database).summary(1, 2026).calculation.revenue).toBe(
      100000,
    );
    expect(() => history.versions(2, id)).toThrow('Invoice not found');
    expect(() => history.versionDetails(2, id, 0)).toThrow('Invoice not found');
    expect(() => history.downloadVersion(2, id, 0)).toThrow(
      'Invoice not found',
    );
    expect(() => history.versionDetails(1, id, 3)).toThrow(
      'Invoice version not found',
    );
    history.save(1, payload, Buffer.from('new-original-number'));
  });
  it('preserves originals on render failure, rejects foreign and invalid edits, and allows retry', async () => {
    const id = history.save(1, payload, Buffer.from('original'));
    const edit = { ...payload, revision: 0 };
    generate.mockRejectedValueOnce(new Error('Renderer failed'));
    await expect(
      controller.update(edit, req('failed-edit-key-0001'), id, response()),
    ).rejects.toThrow('Renderer failed');
    expect(history.details(1, id).revision).toBe(0);
    expect(history.download(1, id).zip).toEqual(Buffer.from('original'));
    expect(history.versions(1, id).versions).toHaveLength(1);
    await expect(
      controller.update(
        { ...edit, items: [] },
        req('invalid-edit-key-0001'),
        id,
        response(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const foreign = req('foreign-edit-key-0001');
    foreign.user.id = 2;
    await expect(
      controller.update(edit, foreign, id, response()),
    ).rejects.toMatchObject({ status: 404 });
    await controller.update(edit, req('failed-edit-key-0001'), id, response());
    expect(history.details(1, id).revision).toBe(1);
  });
  it('rejects conflicting numbers and blocks deletion while an edit renders', async () => {
    const id = history.save(1, payload, Buffer.from('original'));
    history.save(
      1,
      { ...payload, invoiceNumber: 'SF 002' },
      Buffer.from('other'),
    );
    await expect(
      controller.update(
        { ...payload, invoiceNumber: 'SF 002', revision: 0 },
        req('conflict-edit-key-001'),
        id,
        response(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    let finish!: (value: Buffer) => void;
    generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = controller.update(
      { ...payload, revision: 0 },
      req('concurrent-edit-key-1'),
      id,
      response(),
    );
    expect(() => history.remove(1, id)).toThrow(ConflictException);
    await expect(
      controller.regenerate(req('unused-request-key'), id, response()),
    ).rejects.toBeInstanceOf(ConflictException);
    finish(Buffer.from('new'));
    await operation;
    history.remove(1, id);
  });
  it('updates tax amounts and default dates while preserving explicitly reviewed earned dates', async () => {
    const id = history.save(1, payload, Buffer.from('original'));
    const taxes = new TaxService(database);
    taxes.earnedDate(1, id, { earnedDate: '2026-09-30' });
    await controller.update(
      {
        ...payload,
        revision: 0,
        invoiceDate: '2026-11-01',
        paymentTerm: '2026-12-01',
        items: [{ description: 'Work', unit: 'd', quantity: 20, price: 1000 }],
      },
      req('tax-edited-invoice-01'),
      id,
      response(),
    );
    const c = taxes.summary(1, 2026);
    expect(c.calculation.revenue).toBe(2000000);
    expect(c.calculation.billedThroughMonth).toBe(9);
    expect(c.invoices[0].earnedDate).toBe('2026-09-30');
    database.db
      .prepare('DELETE FROM invoice_tax_metadata WHERE invoice_id=?')
      .run(id);
    expect(taxes.summary(1, 2026).calculation.billedThroughMonth).toBe(11);
  });
  it('rechecks a number claimed by another generation while the edit was rendering', async () => {
    const id = history.save(1, payload, Buffer.from('original'));
    let finish!: (value: Buffer) => void;
    generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = controller.update(
      { ...payload, invoiceNumber: 'SF 002', revision: 0 },
      req('race-edit-request-01'),
      id,
      response(),
    );
    history.begin(1, 'other-tab-request-01', 'other-fingerprint', {
      ...payload,
      invoiceNumber: 'SF 002',
    });
    finish(Buffer.from('edited'));
    await expect(operation).rejects.toBeInstanceOf(ConflictException);
    expect(history.details(1, id).revision).toBe(0);
    expect(history.download(1, id).zip).toEqual(Buffer.from('original'));
  });
  it('rolls back the current invoice and request when saving a version fails', async () => {
    const id = history.save(1, payload, Buffer.from('original'));
    database.db.exec(
      "CREATE TRIGGER fail_version BEFORE INSERT ON invoice_versions WHEN NEW.revision > 0 BEGIN SELECT RAISE(ABORT,'Storage failure'); END",
    );
    const edit = { ...payload, revision: 0, invoiceNumber: 'SF 9' };
    await expect(
      controller.update(edit, req('transaction-fail-0001'), id, response()),
    ).rejects.toThrow('Storage failure');
    expect(history.details(1, id)).toMatchObject({
      revision: 0,
      invoiceNumber: payload.invoiceNumber,
    });
    expect(history.download(1, id).zip).toEqual(Buffer.from('original'));
    expect(history.versions(1, id).versions).toHaveLength(1);
    expect(history.nextNumber(1)).toBe('SF 002');
    database.db.exec('DROP TRIGGER fail_version');
    await controller.update(edit, req('transaction-fail-0001'), id, response());
    expect(history.versions(1, id).versions).toHaveLength(2);
  });
  it('retains immutable versions, paginates to revision zero, and cascades an explicit deletion', async () => {
    const id = history.save(1, payload, Buffer.from('original'));
    for (let revision = 0; revision < 51; revision++) {
      await controller.update(
        { ...payload, revision, additionalComment: String(revision) },
        req(`pagination-edit-${String(revision).padStart(4, '0')}`),
        id,
        response(),
      );
    }
    const first = history.versions(1, id);
    expect(first.versions).toHaveLength(50);
    expect(first.nextRevision).toBe(2);
    expect(
      history
        .versions(1, id, first.nextRevision!)
        .versions.map((v) => v.revision),
    ).toEqual([1, 0]);
    expect(history.versions(1, id, 0).versions).toEqual([]);
    expect(() =>
      database.db
        .prepare('UPDATE invoice_versions SET total=0 WHERE invoice_id=?')
        .run(id),
    ).toThrow('immutable');
    expect(() =>
      database.db
        .prepare('DELETE FROM invoice_versions WHERE invoice_id=?')
        .run(id),
    ).toThrow('Delete the invoice');
    expect(() =>
      controller.versionDetails(req('validation-key-0001'), id, -1),
    ).toThrow('Invalid invoice version');
    expect(() =>
      controller.versions(req('validation-key-0001'), id, '9007199254740992'),
    ).toThrow('Invalid version');
    history.remove(1, id);
    expect(
      database.db
        .prepare(
          'SELECT COUNT(*) AS count FROM invoice_versions WHERE invoice_id=?',
        )
        .get(id)?.count,
    ).toBe(0);
    expect(history.nextNumber(1)).toBe('SF 1');
  });
  it.each([
    { invoiceDate: '2026-02-29' },
    { paymentTerm: '2026-09-01' },
    { items: [] },
    { seller: { ...payload.seller, name: '' } },
    { items: [{ ...payload.items[0], quantity: 0 }] },
    { items: [{ ...payload.items[0], price: 1.001 }] },
  ])('rejects invalid issuance before rendering (%j)', async (patch) => {
    await expect(
      controller.generate(
        { ...payload, ...patch },
        req('validation-request-01'),
        response(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(generate).not.toHaveBeenCalled();
  });
});
