import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import rules from '../../../shared/invoice-rules.cjs';
import { PassThrough } from 'stream';
import { GenerateInvoiceDto } from './invoice.dto';

// ─── English number-to-words ────────────────────────────────────────────────

const EN_ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

function enHundreds(n: number): string {
  if (n < 20) return EN_ONES[n];
  if (n < 100) {
    const t = EN_TENS[Math.floor(n / 10)];
    const o = EN_ONES[n % 10];
    return o ? `${t} ${o}` : t;
  }
  const h = `${EN_ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest ? `${h} ${enHundreds(rest)}` : h;
}

function numberToWordsEn(amount: number): string {
  const rounded = Math.round(amount * 100);
  const euros = Math.floor(rounded / 100);
  const cents = rounded % 100;

  let eurosPart: string;
  if (euros === 0) {
    eurosPart = 'zero';
  } else if (euros < 1000) {
    eurosPart = enHundreds(euros);
  } else {
    const thousands = Math.floor(euros / 1000);
    const remainder = euros % 1000;
    eurosPart = `${enHundreds(thousands)} thousand`;
    if (remainder) eurosPart += ` ${enHundreds(remainder)}`;
  }

  const centsPart = cents === 0 ? 'zero' : enHundreds(cents);
  return `${eurosPart} EUR and ${centsPart} cents`;
}

// ─── Lithuanian number-to-words ──────────────────────────────────────────────

const LT_ONES = [
  '',
  'vienas',
  'du',
  'trys',
  'keturi',
  'penki',
  'šeši',
  'septyni',
  'aštuoni',
  'devyni',
  'dešimt',
  'vienuolika',
  'dvylika',
  'trylika',
  'keturiolika',
  'penkiolika',
  'šešiolika',
  'septyniolika',
  'aštuoniolika',
  'devyniolika',
];
const LT_TENS = [
  '',
  '',
  'dvidešimt',
  'trisdešimt',
  'keturiasdešimt',
  'penkiasdešimt',
  'šešiasdešimt',
  'septyniasdešimt',
  'aštuoniasdešimt',
  'devyniasdešimt',
];
const LT_HUNDREDS = [
  '',
  'šimtas',
  'du šimtai',
  'trys šimtai',
  'keturi šimtai',
  'penki šimtai',
  'šeši šimtai',
  'septyni šimtai',
  'aštuoni šimtai',
  'devyni šimtai',
];

function ltHundreds(n: number): string {
  if (n === 0) return '';
  if (n < 20) return LT_ONES[n];
  if (n < 100) {
    const t = LT_TENS[Math.floor(n / 10)];
    const o = LT_ONES[n % 10];
    return o ? `${t} ${o}` : t;
  }
  const h = LT_HUNDREDS[Math.floor(n / 100)];
  const rest = n % 100;
  if (rest === 0) return h;
  return `${h} ${ltHundreds(rest)}`;
}

function ltThousandsForm(n: number): string {
  // returns "tūkstantis", "tūkstančiai", or "tūkstančių"
  if (n % 100 >= 11 && n % 100 <= 19) return 'tūkstančių';
  if (n % 10 === 1) return 'tūkstantis';
  if (n % 10 >= 2 && n % 10 <= 9) return 'tūkstančiai';
  return 'tūkstančių';
}

const LT_THOUSANDS_ONES = [
  '',
  'vienas',
  'du',
  'trys',
  'keturi',
  'penki',
  'šeši',
  'septyni',
  'aštuoni',
  'devyni',
];

function ltThousandsPart(n: number): string {
  // n is the number of thousands (1-99)
  if (n < 10) {
    return `${LT_THOUSANDS_ONES[n]} ${ltThousandsForm(n)}`;
  }
  if (n < 20) {
    return `${LT_ONES[n]} ${ltThousandsForm(n)}`;
  }
  const t = LT_TENS[Math.floor(n / 10)];
  const o = LT_ONES[n % 10];
  const word = o ? `${t} ${o}` : t;
  return `${word} ${ltThousandsForm(n)}`;
}

function ltCentForm(n: number): string {
  const lastTwo = n % 100;
  const lastOne = n % 10;
  if (lastTwo >= 10 && lastTwo <= 19) return 'centų';
  if (lastOne === 0) return 'centų';
  if (lastOne === 1) return 'centas';
  return 'centai';
}

function numberToWordsLt(amount: number): string {
  const rounded = Math.round(amount * 100);
  const euros = Math.floor(rounded / 100);
  const cents = rounded % 100;

  let eurosPart: string;
  if (euros === 0) {
    eurosPart = 'nulis';
  } else if (euros < 1000) {
    eurosPart = ltHundreds(euros);
  } else {
    const thousands = Math.floor(euros / 1000);
    const remainder = euros % 1000;
    eurosPart = ltThousandsPart(thousands);
    if (remainder) eurosPart += ` ${ltHundreds(remainder)}`;
  }

  const centsPart = cents === 0 ? 'nulis' : ltHundreds(cents);
  return `${eurosPart} EUR ir ${centsPart} ${ltCentForm(cents)}`;
}

// ─── HTML generation ─────────────────────────────────────────────────────────

interface Labels {
  title: string;
  invoiceNo: string;
  invoiceDate: string;
  paymentTerm: string;
  seller: string;
  buyer: string;
  individualActivity: string;
  taxNumber: string;
  bankName: string;
  swift: string;
  iban: string;
  vatCode: string;
  descHeader: string;
  qtyHeader: string;
  unitHeader: string;
  priceHeader: string;
  subtotalHeader: string;
  totalLabel: string;
  totalInWords: string;
  comment: string;
  issuedBy: string;
  invoiceAccepted: string;
}

const EN_LABELS: Labels = {
  title: 'INVOICE',
  invoiceNo: 'Invoice No.',
  invoiceDate: 'Invoice Date',
  paymentTerm: 'Payment Term',
  seller: 'SELLER',
  buyer: 'BUYER',
  individualActivity: 'Individual activity',
  taxNumber: 'Tax registration number',
  bankName: 'Name of the bank',
  swift: 'SWIFT code',
  iban: 'IBAN',
  vatCode: 'VAT code',
  descHeader: 'Description',
  qtyHeader: 'Qty',
  unitHeader: 'Unit',
  priceHeader: 'Price',
  subtotalHeader: 'Subtotal',
  totalLabel: 'TOTAL',
  totalInWords: 'Total in words',
  comment: 'Additional comment',
  issuedBy: 'Issued by',
  invoiceAccepted: 'Invoice accepted',
};

const LT_LABELS: Labels = {
  title: 'SĄSKAITA FAKTŪRA',
  invoiceNo: 'Serija SF Nr.',
  invoiceDate: 'Sąskaitos data',
  paymentTerm: 'Apmokėti iki',
  seller: 'Pardavėjas',
  buyer: 'Pirkėjas',
  individualActivity: 'IV pažymos nr.',
  taxNumber: 'Tax registration number',
  bankName: 'Bankas',
  swift: 'SWIFT kodas',
  iban: 'Sąskaita',
  vatCode: 'PVM mokėtojo kodas',
  descHeader: 'Pavadinimas',
  qtyHeader: 'Kiekis',
  unitHeader: 'Matas',
  priceHeader: 'Kaina',
  subtotalHeader: 'Iš viso',
  totalLabel: 'Bendra suma',
  totalInWords: 'Suma žodžiais',
  comment: 'Pastabos',
  issuedBy: 'Sąskaitą išrašė',
  invoiceAccepted: 'Sąskaitą priėmė',
};

const LT_COUNTRY_NAMES: Record<string, string> = {
  Lithuania: 'Lietuva',
  Belgium: 'Belgija',
  France: 'Prancūzija',
  Germany: 'Vokietija',
  Netherlands: 'Nyderlandai',
  Luxembourg: 'Liuksemburgas',
  Poland: 'Lenkija',
  Latvia: 'Latvija',
  Estonia: 'Estija',
  Sweden: 'Švedija',
  Finland: 'Suomija',
  Denmark: 'Danija',
  Norway: 'Norvegija',
  Austria: 'Austrija',
  Switzerland: 'Šveicarija',
  'United Kingdom': 'Jungtinė Karalystė',
  Ireland: 'Airija',
  Spain: 'Ispanija',
  Portugal: 'Portugalija',
  Italy: 'Italija',
  'Czech Republic': 'Čekija',
  Slovakia: 'Slovakija',
  Hungary: 'Vengrija',
  Romania: 'Rumunija',
  Bulgaria: 'Bulgarija',
  Croatia: 'Kroatija',
  'United States': 'Jungtinės Valstijos',
  USA: 'JAV',
};

function translateCountryToLt(address: string): string {
  let result = address;
  for (const [en, lt] of Object.entries(LT_COUNTRY_NAMES)) {
    result = result.replace(new RegExp(`\\b${en}\\b`, 'g'), lt);
  }
  return result;
}

@Injectable()
export class InvoiceService {
  generateHtml(data: GenerateInvoiceDto, lang: 'en' | 'lt'): string {
    const escape = (value: string): string =>
      value.replace(
        /[&<>"']/g,
        (character) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[character]!,
      );
    const escapeRecord = <T extends object>(value: T): T =>
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          typeof entry === 'string' ? escape(entry) : entry,
        ]),
      ) as T;
    data = {
      ...escapeRecord(data),
      seller: escapeRecord(data.seller),
      buyer: escapeRecord(data.buyer),
      items: data.items.map(escapeRecord),
    };
    const L = lang === 'en' ? EN_LABELS : LT_LABELS;
    const {
      seller,
      buyer,
      items,
      invoiceNumber,
      invoiceDate,
      paymentTerm,
      additionalComment,
    } = data;

    const sellerAddress =
      lang === 'lt' ? translateCountryToLt(seller.address) : seller.address;
    const buyerAddress =
      lang === 'lt' ? translateCountryToLt(buyer.address) : buyer.address;

    const amounts = rules.calculate(items, data.calculationVersion ?? 1);
    const total = amounts.total;
    const totalWords =
      lang === 'en' ? numberToWordsEn(total) : numberToWordsLt(total);

    const itemRows = items
      .map((item, idx) => {
        const subtotal = amounts.lines[idx];
        return `
        <tr>
          <td>${idx + 1}</td>
          <td>${item.description}</td>
          <td class="num">${item.quantity}</td>
          <td>${item.unit}</td>
          <td class="num">${item.price.toFixed(2)}</td>
          <td class="num">${subtotal.toFixed(2)}</td>
        </tr>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: 'Times New Roman', serif; font-size: 11pt; color: #000; margin: 0; padding: 40px 50px; }
  h1 { text-align: center; font-size: 18pt; margin-bottom: 4px; }
  .meta { text-align: center; margin-bottom: 30px; font-size: 11pt; }
  .meta-row { margin: 2px 0; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 30px; }
  .party { width: 48%; }
  .party-label { font-weight: bold; margin-bottom: 6px; border-bottom: 1px solid #000; padding-bottom: 4px; }
  .party-line { margin: 2px 0; }
  .party-field-label { font-style: italic; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 6px 4px; text-align: left; font-weight: bold; }
  th.num, td.num { text-align: right; }
  td { padding: 6px 4px; border-bottom: 1px solid #ddd; }
  .total-row td { border-top: 2px solid #000; border-bottom: none; font-weight: bold; }
  .words { margin-top: 20px; font-size: 10pt; }
  .footer { margin-top: 40px; }
  .footer-row { margin-bottom: 20px; }
  .comment-label { font-weight: bold; }
</style>
</head>
<body>
  <h1>${L.title}</h1>
  <div class="meta">
    <div class="meta-row"><strong>${L.invoiceNo}</strong> ${invoiceNumber}</div>
    <div class="meta-row"><strong>${L.invoiceDate}:</strong> ${invoiceDate}</div>
    <div class="meta-row"><strong>${L.paymentTerm}:</strong> ${paymentTerm}</div>
  </div>

  <div class="parties">
    <div class="party">
      <div class="party-label">${L.seller}</div>
      <div class="party-line"><strong>${seller.name}</strong></div>
      <div class="party-line"><span class="party-field-label">${L.individualActivity}:</span> ${seller.individualActivity}</div>
      <div class="party-line"><span class="party-field-label">${L.taxNumber}:</span> ${seller.taxNumber}</div>
      <div class="party-line">${sellerAddress}</div>
      <div class="party-line" style="margin-top:6px;"><span class="party-field-label">${L.bankName}:</span> ${seller.bankName}</div>
      <div class="party-line"><span class="party-field-label">${L.swift}:</span> ${seller.swift}</div>
      <div class="party-line"><span class="party-field-label">${L.iban}:</span> ${seller.iban}</div>
    </div>
    <div class="party">
      <div class="party-label">${L.buyer}</div>
      <div class="party-line"><strong>${buyer.name}</strong></div>
      <div class="party-line"><span class="party-field-label">${L.vatCode}:</span> ${buyer.vatCode}</div>
      <div class="party-line">${buyerAddress}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>${L.descHeader}</th>
        <th class="num">${L.qtyHeader}</th>
        <th>${L.unitHeader}</th>
        <th class="num">${L.priceHeader}</th>
        <th class="num">${L.subtotalHeader}</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      <tr class="total-row">
        <td colspan="5">${L.totalLabel}</td>
        <td class="num">${total.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <div class="words">
    <strong>${L.totalInWords}:</strong> ${totalWords}
  </div>

  <div class="footer">
    <div class="footer-row"><strong>${L.issuedBy}:</strong> ${seller.name}</div>
    <div class="footer-row"><strong>${L.invoiceAccepted}:</strong> ____________</div>
    ${additionalComment ? `<div class="footer-row"><span class="comment-label">${L.comment}:</span> ${additionalComment}</div>` : ''}
  </div>
</body>
</html>`;
  }

  async generatePdf(html: string): Promise<Buffer> {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  async generate(data: GenerateInvoiceDto): Promise<Buffer> {
    const [htmlEn, htmlLt] = [
      this.generateHtml(data, 'en'),
      this.generateHtml(data, 'lt'),
    ];
    const [pdfEn, pdfLt] = await Promise.all([
      this.generatePdf(htmlEn),
      this.generatePdf(htmlLt),
    ]);

    const safeNum = data.invoiceNumber.replace(/\s+/g, '-');

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const passThrough = new PassThrough();
      passThrough.on('data', (chunk: Buffer) => chunks.push(chunk));
      passThrough.on('end', () => resolve(Buffer.concat(chunks)));
      passThrough.on('error', reject);

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', reject);
      archive.pipe(passThrough);

      archive.append(pdfEn, { name: `invoice-${safeNum}-en.pdf` });
      archive.append(pdfLt, { name: `invoice-${safeNum}-lt.pdf` });
      void archive.finalize().catch(reject);
    });
  }
}
