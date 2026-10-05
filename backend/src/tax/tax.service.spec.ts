import { DatabaseService } from '../account/database.service';
import { TaxService } from './tax.service';
import { defaultTaxSettings } from './tax-calculator';
describe('Account-owned tax records and aggregation', () => {
  let database: DatabaseService;
  let taxes: TaxService;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ':memory:';
    database = new DatabaseService();
    taxes = new TaxService(database);
    const add = database.db.prepare(
      'INSERT INTO users(id,email,password_hash,created_at,preferences) VALUES (?,?,?,0,?)',
    );
    add.run(1, 'one@example.test', 'test', '{}');
    add.run(2, 'two@example.test', 'test', '{}');
  });
  afterEach(() => {
    database.onModuleDestroy();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  });
  const invoice = (
    db: DatabaseService,
    n: number,
    user = 1,
    day = '2026-01-01',
  ) =>
    db.db
      .prepare(
        "INSERT INTO invoices(id,user_id,invoice_number,invoice_date,payment_term,buyer_name,total,payload,zip,created_at,calculation_version,total_cents) VALUES (?,?,'SF 44',?,?,'Buyer',100,'{}',X'010203',0,1,10000)",
      )
      .run(n, user, day, day);
  const profile = () => ({
    ...defaultTaxSettings(),
    profileConfirmed: true,
    psdReviewed: true,
    onlyActivityIncome: 'yes',
  });
  const entry = (patch: object = {}) => ({
    kind: 'PSD',
    date: '2027-01-02',
    amount: '80.48',
    note: 'Monthly payment',
    requestKey: '12345678-1234-1234-1234-123456789012',
    ...patch,
  });
  it('divides by months through the latest earned month, including gaps, and refreshes after deletion', () => {
    invoice(database, 1, 1, '2026-01-31');
    invoice(database, 2, 1, '2026-09-30');
    taxes.saveSettings(1, 2026, profile());
    const c = taxes.summary(1, 2026).calculation;
    expect(c.billedThroughMonth).toBe(9);
    expect(c.billedMonthlyAverage).toBe(Math.round(c.net! / 9));
    expect(c.monthlyAverage).toBe(Math.round(c.net! / 12));
    taxes.earnedDate(1, 2, { earnedDate: '2025-12-31' });
    expect(taxes.summary(1, 2026).calculation.billedThroughMonth).toBe(1);
    database.db.prepare('DELETE FROM invoices WHERE id=1').run();
    expect(taxes.summary(1, 2026).calculation.billedMonthlyAverage).toBeNull();
    taxes.saveEntry(
      1,
      2026,
      entry({ kind: 'income', date: '2026-09-30', amount: '1000' }),
    );
    expect(taxes.summary(1, 2026).calculation.billedThroughMonth).toBe(9);
  });
  it('aggregates all pages and reused numbers without touching original ZIPs', () => {
    for (let i = 1; i <= 60; i++) invoice(database, i);
    invoice(database, 61, 2);
    taxes.saveSettings(1, 2026, profile());
    const s = taxes.summary(1, 2026);
    expect(s.invoices).toHaveLength(60);
    expect(s.calculation.revenue).toBe(600000);
    expect(
      database.db
        .prepare('SELECT hex(zip) AS zip FROM invoices WHERE id=1')
        .get()?.zip,
    ).toBe('010203');
    expect(taxes.summary(2, 2026).invoices).toHaveLength(1);
    expect(taxes.summary(2, 2026).settings.profileConfirmed).toBe(false);
  });
  it('recognizes earned dates across years and prevents cross-account edits', () => {
    invoice(database, 1, 1, '2027-01-05');
    expect(() => taxes.earnedDate(2, 1, { earnedDate: '2026-12-31' })).toThrow(
      'Invoice not found',
    );
    taxes.earnedDate(1, 1, { earnedDate: '2026-12-31' });
    expect(taxes.summary(1, 2026).calculation.revenue).toBe(10000);
    expect(taxes.summary(1, 2027).invoices).toHaveLength(0);
    database.db.prepare('DELETE FROM invoices WHERE id=1').run();
    expect(taxes.summary(1, 2026).calculation.revenue).toBe(0);
    expect(
      database.db
        .prepare('SELECT COUNT(*) AS n FROM invoice_tax_metadata')
        .get()?.n,
    ).toBe(0);
  });
  it('uses legacy displayed totals rather than recomputing payloads', () => {
    invoice(database, 1);
    database.db
      .prepare(
        'UPDATE invoices SET total=0.005,total_cents=NULL,calculation_version=0 WHERE id=1',
      )
      .run();
    expect(taxes.summary(1, 2026).calculation.revenue).toBe(1);
  });
  it('deduplicates retries, isolates payment records and preserves tax-year allocation', () => {
    taxes.saveSettings(1, 2026, profile());
    taxes.saveEntry(1, 2026, entry());
    taxes.saveEntry(1, 2026, entry());
    const s = taxes.summary(1, 2026);
    expect(s.entries).toHaveLength(1);
    expect(s.paid.PSD).toBe(8048);
    expect(s.balances.PSD).toBe(88528);
    expect(s.calculation.net).toBe(-96576);
    expect(() => taxes.saveEntry(1, 2026, entry({ amount: '100.00' }))).toThrow(
      'different record',
    );
    expect(() => taxes.saveEntry(2, 2026, entry(), s.entries[0].id)).toThrow(
      'Record not found',
    );
    taxes.deleteEntry(2, 2026, s.entries[0].id);
    expect(taxes.summary(1, 2026).entries).toHaveLength(1);
    taxes.saveEntry(1, 2026, entry({ amount: '100.00' }), s.entries[0].id);
    expect(taxes.summary(1, 2026).paid.PSD).toBe(10000);
    expect(taxes.summary(2, 2026).entries).toHaveLength(0);
  });
  it('validates signed adjustments and CSV escaping, and bulk-reviews only owned dates', () => {
    invoice(database, 1);
    invoice(database, 2, 2);
    taxes.reviewDates(1, 2026);
    expect(taxes.summary(1, 2026).unreviewed).toBe(0);
    expect(taxes.summary(2, 2026).unreviewed).toBe(1);
    taxes.saveEntry(
      1,
      2026,
      entry({
        kind: 'income',
        date: '2026-01-01',
        amount: '-1.23',
        note: '=HYPERLINK("bad")',
      }),
    );
    expect(taxes.summary(1, 2026).calculation.revenue).toBe(9877);
    expect(taxes.csv(1, 2026)).toContain('"\'=HYPERLINK(""bad"")"');
    expect(() =>
      taxes.saveEntry(1, 2026, entry({ kind: 'income', date: '2027-01-01' })),
    ).toThrow('selected year');
    expect(() => taxes.saveEntry(1, 2026, entry({ amount: '1.234' }))).toThrow(
      'two decimal',
    );
    expect(() => taxes.saveEntry(1, 2026, entry({ amount: '-1' }))).toThrow(
      'positive',
    );
  });
});
