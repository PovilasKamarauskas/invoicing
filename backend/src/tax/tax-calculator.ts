export interface TaxSettings {
  profileConfirmed: boolean;
  onlyActivityIncome: 'unknown' | 'yes' | 'no';
  psdMonths: boolean[];
  psdReviewed: boolean;
  partialMonth: boolean;
}
export const defaultTaxSettings = (): TaxSettings => ({
  profileConfirmed: false,
  onlyActivityIncome: 'unknown',
  psdMonths: Array.from({ length: 12 }, () => true),
  psdReviewed: false,
  partialMonth: false,
});
export const TAX_RULES_VERSION = 'lt-iv-2026-v1';
export const roundRatio = (n: bigint, d: bigint): number =>
  Number(n < 0n ? -((-n + d / 2n) / d) : (n + d / 2n) / d);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const positive = (n: bigint) => (n > 0n ? n : 0n);

export function gpmForProfit(
  p10: bigint,
  onlyActivityIncome: boolean,
): number | null {
  if (p10 <= 20000000n) return roundRatio(p10, 200n);
  if (p10 <= 42500000n) return roundRatio(p10 * (p10 - 12500000n), 1500000000n);
  if (!onlyActivityIncome) return null;
  const lower = min(p10, 83237400n);
  const middle = min(positive(p10 - 83237400n), 55491600n);
  const upper = positive(p10 - 138729000n);
  return roundRatio(lower * 20n + middle * 25n + upper * 32n, 1000n);
}

/** Largest-remainder allocation: exact cents, stable month-order ties. */
export function allocate(total: number, revenues: number[]): number[] {
  const weights = revenues.map((n) => BigInt(Math.max(n, 0)));
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (!sum) return weights.map(() => 0);
  const products = weights.map((w) => w * BigInt(total));
  const result = products.map((n) => Number(n / sum));
  const order = products
    .map((n, i) => ({ i, remainder: n % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.i - b.i
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  const extra = total - result.reduce((a, b) => a + b, 0);
  for (let i = 0; i < extra; i++) result[order[i].i]++;
  return result;
}

export function calculateTax(
  year: number,
  revenues: number[],
  settings: TaxSettings,
) {
  const revenue = revenues.reduce((a, b) => a + b, 0);
  const supported = year === 2026;
  const issues: string[] = [];
  if (!supported)
    issues.push(
      'Tax rules are available for 2026 only. Income totals remain available.',
    );
  if (!settings.profileConfirmed)
    issues.push(
      'Confirm the 30% expense, no-extra-pension and standard contribution profile.',
    );
  if (revenue < 0)
    issues.push(
      'Adjustments make annual revenue negative. Review the income records.',
    );
  const valid = supported && settings.profileConfirmed && revenue >= 0;
  const r = BigInt(Math.max(revenue, 0));
  const p10 = r * 7n; // taxable profit in tenths of a cent; no intermediate rounding
  const base100 = min(r * 63n, 994224500n); // social base in hundredths of a cent
  let gpm: number | null = null;
  if (valid) {
    gpm = gpmForProfit(p10, settings.onlyActivityIncome === 'yes');
    if (gpm === null)
      issues.push(
        'Above €42,500 profit, GPM needs confirmation that there is no other relevant income.',
      );
  }
  const vsd = valid ? roundRatio(base100 * 1252n, 1000000n) : null;
  const psdIncome = valid ? roundRatio(base100 * 698n, 1000000n) : null;
  const minimums = settings.psdMonths.map((required) => (required ? 8048 : 0));
  const psdMinimum = minimums.reduce((a, b) => a + b, 0);
  if (valid && !settings.psdReviewed)
    issues.push('Review the months with required PSD payments.');
  if (valid && settings.partialMonth)
    issues.push(
      'Partial-month or coverage-transition PSD needs an individual calculation.',
    );
  const psd =
    valid && settings.psdReviewed && !settings.partialMonth
      ? Math.max(psdIncome!, psdMinimum)
      : null;
  const complete = gpm !== null && vsd !== null && psd !== null;
  const total = complete ? gpm! + vsd + psd : null;
  const net = total === null ? null : revenue - total;
  const gpmMonths = gpm === null ? null : allocate(gpm, revenues);
  const vsdMonths = vsd === null ? null : allocate(vsd, revenues);
  const topups = psd === null ? null : allocate(psd - psdMinimum, revenues);
  const months = revenues.map((amount, i) => {
    const monthlyPsd = topups === null ? null : minimums[i] + topups[i];
    const monthlyGpm = gpmMonths?.[i] ?? null;
    const monthlyVsd = vsdMonths?.[i] ?? null;
    return {
      month: i + 1,
      revenue: amount,
      deduction: roundRatio(BigInt(amount) * 3n, 10n),
      gpm: monthlyGpm,
      vsd: monthlyVsd,
      psd: monthlyPsd,
      net: complete ? amount - monthlyGpm! - monthlyVsd! - monthlyPsd! : null,
      psdMinimum: supported ? minimums[i] : null,
    };
  });
  return {
    supported,
    complete,
    issues,
    revenue,
    deduction: roundRatio(r * 3n, 10n),
    profit: roundRatio(p10, 10n),
    base: supported ? roundRatio(base100, 100n) : null,
    gpm,
    vsd,
    psd,
    psdIncome,
    psdMinimum: supported ? psdMinimum : null,
    gpmCredit:
      gpm !== null && p10 <= 42500000n ? roundRatio(p10, 50n) - gpm : null,
    total,
    availableSubtotal: [gpm, vsd, psd].reduce<number>(
      (a, b) => a + (b ?? 0),
      0,
    ),
    net,
    monthlyAverage: net === null ? null : roundRatio(BigInt(net), 12n),
    months,
    rulesVersion: supported ? TAX_RULES_VERSION : null,
  };
}
