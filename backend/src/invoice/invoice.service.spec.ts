import { InvoiceService } from './invoice.service';

describe('Invoice HTML', () => {
  it('escapes user text in both language versions', () => {
    const service = new InvoiceService();
    const data = {
      invoiceNumber: 'SF 1',
      invoiceDate: '2026-10-03',
      paymentTerm: '2026-11-02',
      seller: {
        name: '<script>alert(1)</script>',
        individualActivity: '',
        taxNumber: '',
        address: 'Lithuania',
        bankName: '',
        swift: '',
        iban: '',
      },
      buyer: { name: 'Buyer & Co', vatCode: '', address: '' },
      items: [
        {
          description: '<img src="https://example.com">',
          quantity: 2,
          unit: 'h',
          price: 10,
        },
      ],
      additionalComment: '<b>Comment</b>',
    };
    for (const lang of ['en', 'lt'] as const) {
      const html = service.generateHtml(data, lang);
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img ');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('Buyer &amp; Co');
      expect(html).toContain('20.00');
    }
    expect(service.generateHtml(data, 'lt')).toContain('Lietuva');
  });
});
