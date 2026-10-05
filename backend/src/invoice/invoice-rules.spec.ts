import rules from '../../../shared/invoice-rules.cjs';
import { InvoiceService } from './invoice.service';

describe('Invoice calculation and calendar rules', () => {
  it('counts Monday through Friday for the full current month', () => {
    expect(rules.workingDays(new Date(2026, 9, 3))).toBe(22);
    expect(rules.workingDays(new Date(2026, 1, 1))).toBe(20);
    expect(rules.workingDays(new Date(2024, 1, 29))).toBe(21);
  });
  it('rounds fractional lines half-up before summing', () => {
    expect(
      rules.calculate([
        { price: 0.01, quantity: 0.5 },
        { price: 0.01, quantity: 0.5 },
      ]),
    ).toEqual({ lines: [0.01, 0.01], total: 0.02, totalCents: 2 });
    expect(rules.calculate([{ price: 3.99, quantity: 0.5 }]).totalCents).toBe(
      200,
    );
    expect(rules.calculate([{ price: 1.15, quantity: 3 }]).totalCents).toBe(
      345,
    );
    expect(rules.calculate([{ price: 0.01, quantity: 0.5 }], 0).total).toBe(
      0.005,
    );
  });
  it('uses the same total for numeric and word amounts in both PDFs', () => {
    const data = {
      invoiceNumber: 'SF 1',
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
      items: [{ description: 'Work', quantity: 0.5, unit: 'h', price: 3.99 }],
      additionalComment: '',
    };
    const service = new InvoiceService();
    expect(service.generateHtml(data, 'en')).toContain(
      'two EUR and zero cents',
    );
    expect(service.generateHtml(data, 'lt')).toContain('du EUR ir nulis centų');
  });
  it('validates real calendar dates and preserves numbering padding', () => {
    expect(rules.validDate('2026-02-29')).toBe(false);
    expect(rules.validDate('2028-02-29')).toBe(true);
    expect(rules.addDays('2026-10-03', 30)).toBe('2026-11-02');
    expect(rules.addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(rules.nextNumber('SF 009')).toBe('SF 010');
    const date = new Date(2026, 9, 3, 0, 30);
    expect(rules.localDate(date)).toBe('2026-10-03');
  });
});
