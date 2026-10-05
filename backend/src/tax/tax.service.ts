import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../account/database.service';
import rules from '../../../shared/invoice-rules.cjs';
import { calculateTax, defaultTaxSettings, roundRatio } from './tax-calculator';
import type { TaxSettings } from './tax-calculator';

type EntryKind = 'income' | 'GPM' | 'VSD' | 'PSD';
export interface Entry {
  id: number;
  year: number;
  kind: EntryKind;
  date: string;
  amount: number;
  note: string;
  requestKey: string;
  updatedAt: number;
}
export interface Contribution {
  id: number;
  number: string;
  invoiceDate: string;
  earnedDate: string;
  amount: number;
  reviewed: number;
  updatedAt: number;
  legacy: boolean;
}
type DataObject = Record<string, unknown>;
function object(body: unknown): DataObject {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Invalid input.');
  return body as DataObject;
}
export function taxYear(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1900 || n > 9999)
    throw new BadRequestException('Invalid tax year.');
  return n;
}
function id(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new BadRequestException('Invalid record.');
  return n;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !rules.validDate(value))
    throw new BadRequestException('Use a valid YYYY-MM-DD date.');
  return value;
}
function amount(value: unknown, signed: boolean): number {
  if (typeof value !== 'string' || !/^-?\d{1,10}(\.\d{1,2})?$/.test(value))
    throw new BadRequestException(
      'Use an amount with at most two decimal places.',
    );
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const cents =
    Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) *
    (negative ? -1 : 1);
  if (!cents || !Number.isSafeInteger(cents) || (!signed && cents < 0))
    throw new BadRequestException(
      'Payments must be positive; adjustments must be nonzero.',
    );
  return cents;
}
const ENTRY_COLUMNS =
  'id, year, kind, date, amount_cents AS amount, note, request_key AS requestKey, updated_at AS updatedAt';

@Injectable()
export class TaxService {
  constructor(private readonly database: DatabaseService) {}
  private settings(userId: number, year: number): TaxSettings {
    const row = this.database.db
      .prepare(
        'SELECT settings FROM tax_year_settings WHERE user_id = ? AND year = ?',
      )
      .get(userId, year);
    return row
      ? (JSON.parse(String(row.settings)) as TaxSettings)
      : defaultTaxSettings();
  }
  saveSettings(userId: number, year: number, body: unknown) {
    const b = object(body);
    if (
      typeof b.profileConfirmed !== 'boolean' ||
      typeof b.psdReviewed !== 'boolean' ||
      typeof b.partialMonth !== 'boolean' ||
      !['unknown', 'yes', 'no'].includes(String(b.onlyActivityIncome)) ||
      !Array.isArray(b.psdMonths) ||
      b.psdMonths.length !== 12 ||
      b.psdMonths.some((v) => typeof v !== 'boolean')
    )
      throw new BadRequestException('Review all tax profile settings.');
    const settings: TaxSettings = {
      profileConfirmed: b.profileConfirmed,
      psdReviewed: b.psdReviewed,
      partialMonth: b.partialMonth,
      onlyActivityIncome:
        b.onlyActivityIncome as TaxSettings['onlyActivityIncome'],
      psdMonths: b.psdMonths as boolean[],
    };
    this.database.db
      .prepare(
        'INSERT INTO tax_year_settings(user_id,year,settings,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,year) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at',
      )
      .run(userId, year, JSON.stringify(settings), Date.now());
    return settings;
  }
  private invoices(userId: number, year: number): Contribution[] {
    const rows = this.database.db
      .prepare(
        `SELECT i.id, i.invoice_number AS number, i.invoice_date AS invoiceDate,
      COALESCE(m.earned_date,i.invoice_date) AS earnedDate, i.total, i.total_cents AS cents,
      COALESCE(m.reviewed,0) AS reviewed, COALESCE(m.updated_at,i.updated_at,i.created_at) AS updatedAt
      FROM invoices i LEFT JOIN invoice_tax_metadata m ON m.invoice_id=i.id
      WHERE i.user_id=? AND COALESCE(m.earned_date,i.invoice_date)>=? AND COALESCE(m.earned_date,i.invoice_date)<?
      ORDER BY earnedDate,i.id`,
      )
      .all(userId, `${year}-01-01`, `${year + 1}-01-01`);
    return rows.map((row) => ({
      id: Number(row.id),
      number: String(row.number),
      invoiceDate: String(row.invoiceDate),
      earnedDate: String(row.earnedDate),
      // Legacy PDFs display toFixed(2); preserve that displayed saved amount.
      amount:
        row.cents === null
          ? Number(Number(row.total).toFixed(2).replace('.', ''))
          : Number(row.cents),
      reviewed: Number(row.reviewed),
      updatedAt: Number(row.updatedAt),
      legacy: row.cents === null,
    }));
  }
  private entries(userId: number, year: number): Entry[] {
    return this.database.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM tax_entries WHERE user_id=? AND year=? ORDER BY date,id`,
      )
      .all(userId, year) as unknown as Entry[];
  }
  years(userId: number) {
    const rows = this.database.db
      .prepare(
        `SELECT substr(COALESCE(m.earned_date,i.invoice_date),1,4) AS year FROM invoices i LEFT JOIN invoice_tax_metadata m ON m.invoice_id=i.id WHERE i.user_id=?
      UNION SELECT CAST(year AS TEXT) FROM tax_entries WHERE user_id=? UNION SELECT CAST(year AS TEXT) FROM tax_year_settings WHERE user_id=?`,
      )
      .all(userId, userId, userId);
    return [
      ...new Set([
        2026,
        new Date().getFullYear(),
        ...rows.map((r) => Number(r.year)),
      ]),
    ].sort((a, b) => b - a);
  }
  summary(userId: number, year: number) {
    const db = this.database.db;
    db.exec('BEGIN');
    try {
      const settings = this.settings(userId, year);
      const invoices = this.invoices(userId, year);
      const entries = this.entries(userId, year);
      const revenues = Array.from({ length: 12 }, () => 0);
      for (const invoice of invoices)
        revenues[Number(invoice.earnedDate.slice(5, 7)) - 1] += invoice.amount;
      for (const entry of entries)
        if (entry.kind === 'income')
          revenues[Number(entry.date.slice(5, 7)) - 1] += entry.amount;
      if (
        revenues.some(
          (v) => !Number.isSafeInteger(v) || Math.abs(v) > 1000000000000,
        )
      )
        throw new BadRequestException(
          'Income is outside the supported amount range.',
        );
      const billedThroughMonth = Math.max(
        0,
        ...invoices.map((i) => Number(i.earnedDate.slice(5, 7))),
        ...entries
          .filter((e) => e.kind === 'income' && e.amount > 0)
          .map((e) => Number(e.date.slice(5, 7))),
      );
      const annual = calculateTax(year, revenues, settings);
      const calculation = {
        ...annual,
        billedThroughMonth,
        billedMonthlyAverage:
          annual.net === null || !billedThroughMonth
            ? null
            : roundRatio(BigInt(annual.net), BigInt(billedThroughMonth)),
      };

      const paid = { GPM: 0, VSD: 0, PSD: 0 };
      for (const entry of entries)
        if (entry.kind !== 'income') paid[entry.kind] += entry.amount;
      const balances = {
        GPM: calculation.gpm === null ? null : calculation.gpm - paid.GPM,
        VSD: calculation.vsd === null ? null : calculation.vsd - paid.VSD,
        PSD: calculation.psd === null ? null : calculation.psd - paid.PSD,
      };
      const today = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Vilnius',
      }).format(new Date());
      const revision = createHash('sha256')
        .update(
          JSON.stringify({
            year,
            settings,
            invoices,
            entries,
            rules: calculation.rulesVersion,
          }),
        )
        .digest('hex')
        .slice(0, 16);
      db.exec('COMMIT');
      return {
        year,
        settings,
        invoices,
        entries,
        paid,
        balances,
        calculation,
        revision,
        calculatedAt: new Date().toISOString(),
        unreviewed: invoices.filter((i) => !i.reviewed).length,
        futureIncome:
          invoices.filter((i) => i.earnedDate > today).length +
          entries.filter((e) => e.kind === 'income' && e.date > today).length,
        futurePsdMinimum:
          year === 2026
            ? settings.psdMonths.reduce(
                (sum, required, i) =>
                  sum +
                  (required &&
                  `${year}-${String(i + 1).padStart(2, '0')}-01` > today
                    ? 8048
                    : 0),
                0,
              )
            : null,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  earnedDate(userId: number, invoiceId: unknown, body: unknown) {
    const invoice = id(invoiceId);
    if (
      !this.database.db
        .prepare('SELECT id FROM invoices WHERE user_id=? AND id=?')
        .get(userId, invoice)
    )
      throw new NotFoundException('Invoice not found.');
    const earned = date(object(body).earnedDate);
    this.database.db
      .prepare(
        'INSERT INTO invoice_tax_metadata(invoice_id,earned_date,reviewed,updated_at) VALUES (?,?,1,?) ON CONFLICT(invoice_id) DO UPDATE SET earned_date=excluded.earned_date,reviewed=1,updated_at=excluded.updated_at',
      )
      .run(invoice, earned, Date.now());
    return { ok: true };
  }
  reviewDates(userId: number, year: number) {
    this.database.db
      .prepare(
        `INSERT INTO invoice_tax_metadata(invoice_id,earned_date,reviewed,updated_at)
      SELECT i.id,COALESCE(m.earned_date,i.invoice_date),1,? FROM invoices i LEFT JOIN invoice_tax_metadata m ON m.invoice_id=i.id
      WHERE i.user_id=? AND COALESCE(m.earned_date,i.invoice_date)>=? AND COALESCE(m.earned_date,i.invoice_date)<?
      ON CONFLICT(invoice_id) DO UPDATE SET reviewed=1,updated_at=excluded.updated_at`,
      )
      .run(Date.now(), userId, `${year}-01-01`, `${year + 1}-01-01`);
    return { ok: true };
  }
  saveEntry(userId: number, year: number, body: unknown, entryId?: unknown) {
    const b = object(body);
    if (!['income', 'GPM', 'VSD', 'PSD'].includes(String(b.kind)))
      throw new BadRequestException('Select income, GPM, VSD or PSD.');
    const kind = b.kind as EntryKind;
    const day = date(b.date);
    if (kind === 'income' && Number(day.slice(0, 4)) !== year)
      throw new BadRequestException(
        'Income date must be in the selected year.',
      );
    const cents = amount(b.amount, kind === 'income');
    if (
      typeof b.note !== 'string' ||
      b.note.trim().length > 1000 ||
      (kind === 'income' && !b.note.trim())
    )
      throw new BadRequestException(
        'Income adjustments need a reason (maximum 1000 characters).',
      );
    const note = b.note.trim();
    if (entryId !== undefined) {
      const result = this.database.db
        .prepare(
          'UPDATE tax_entries SET kind=?,date=?,amount_cents=?,note=?,updated_at=? WHERE user_id=? AND id=? AND year=?',
        )
        .run(kind, day, cents, note, Date.now(), userId, id(entryId), year);
      if (!result.changes) throw new NotFoundException('Record not found.');
      return { ok: true };
    }
    if (
      typeof b.requestKey !== 'string' ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(b.requestKey)
    )
      throw new BadRequestException('A request key is required.');
    const existing = this.database.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM tax_entries WHERE user_id=? AND request_key=?`,
      )
      .get(userId, b.requestKey) as unknown as Entry | undefined;
    if (existing) {
      if (
        existing.year !== year ||
        existing.kind !== kind ||
        existing.date !== day ||
        existing.amount !== cents ||
        existing.note !== note
      )
        throw new ConflictException(
          'This request key was already used for a different record.',
        );
      return { ok: true, id: existing.id };
    }
    const now = Date.now();
    const result = this.database.db
      .prepare(
        'INSERT INTO tax_entries(user_id,year,kind,date,amount_cents,note,request_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(userId, year, kind, day, cents, note, b.requestKey, now, now);
    return { ok: true, id: Number(result.lastInsertRowid) };
  }
  deleteEntry(userId: number, year: number, entryId: unknown) {
    this.database.db
      .prepare('DELETE FROM tax_entries WHERE user_id=? AND year=? AND id=?')
      .run(userId, year, id(entryId));
    return { ok: true };
  }
  csv(userId: number, year: number) {
    const s = this.summary(userId, year);
    const c = s.calculation;
    const money = (v: number | null) =>
      v === null ? '' : (v / 100).toFixed(2);
    const rows: (string | number)[][] = [
      ['Yearly taxes', year],
      ['Calculated at', s.calculatedAt],
      ['Revision', s.revision],
      ['Rules', c.rulesVersion ?? 'Unavailable'],
      [
        'Profile',
        '30% expenses; no extra pension; accrual; before actual expenses; assumes invoices paid',
      ],
      ['Profile confirmed', String(s.settings.profileConfirmed)],
      ['Only activity income', s.settings.onlyActivityIncome],
      [
        'PSD months',
        s.settings.psdMonths
          .map((v, i) => (v ? i + 1 : ''))
          .filter(Boolean)
          .join(','),
      ],
      ['PSD reviewed', String(s.settings.psdReviewed)],
      ['Partial-month PSD', String(s.settings.partialMonth)],
      ['Unreviewed earned dates', s.unreviewed],
      ['Future-dated income records', s.futureIncome],
      ['Issues', c.issues.join(' | ')],
      ['Revenue EUR', money(c.revenue)],
      ['30% deduction EUR', money(c.deduction)],
      ['Taxable profit EUR', money(c.profit)],
      ['Social base EUR', money(c.base)],
      ['GPM credit EUR', money(c.gpmCredit)],
      ['Tax', 'Liability EUR', 'Recorded paid EUR', 'Balance EUR'],
      ...(['GPM', 'VSD', 'PSD'] as const).map((k) => [
        k,
        money(c[k.toLowerCase() as 'gpm' | 'vsd' | 'psd']),
        money(s.paid[k]),
        money(s.balances[k]),
      ]),
      ['Total estimated tax EUR', money(c.total)],
      ['Annual theoretical take-home EUR', money(c.net)],
      ['Calendar-year monthly average EUR', money(c.monthlyAverage)],
      ['Months through latest billed month', c.billedThroughMonth],
      [
        'Monthly average through latest billed month EUR',
        money(c.billedMonthlyAverage),
      ],
      [],
      [
        'Month',
        'Revenue EUR',
        'Presumed deduction EUR',
        'GPM EUR',
        'VSD EUR',
        'PSD EUR',
        'Theoretical take-home EUR',
      ],
      ...c.months.map((m) => [
        m.month,
        money(m.revenue),
        money(m.deduction),
        money(m.gpm),
        money(m.vsd),
        money(m.psd),
        money(m.net),
      ]),
      [],
      [
        'Invoice ID',
        'Number',
        'Invoice date',
        'Earned date',
        'Amount EUR',
        'Reviewed',
      ],
      ...s.invoices.map((i) => [
        i.id,
        i.number,
        i.invoiceDate,
        i.earnedDate,
        money(i.amount),
        String(!!i.reviewed),
      ]),
      [],
      ['Entry ID', 'Kind', 'Tax year', 'Date', 'Amount EUR', 'Reason'],
      ...s.entries.map((e) => [
        e.id,
        e.kind,
        e.year,
        e.date,
        money(e.amount),
        e.note,
      ]),
    ];
    return (
      '\uFEFF' +
      rows
        .map((row) =>
          row
            .map((v) => {
              let text = String(v);
              if (typeof v === 'string' && /^[\s]*[=+@-]/.test(text))
                text = "'" + text;
              return '"' + text.replace(/"/g, '""') + '"';
            })
            .join(','),
        )
        .join('\r\n')
    );
  }
}
