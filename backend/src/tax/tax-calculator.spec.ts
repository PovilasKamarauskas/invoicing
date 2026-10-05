import {
  allocate,
  calculateTax,
  defaultTaxSettings,
  gpmForProfit,
} from './tax-calculator';
const settings = () => ({
  ...defaultTaxSettings(),
  profileConfirmed: true,
  psdReviewed: true,
  onlyActivityIncome: 'yes' as const,
});
const revenue = (annual: number) => [annual, ...Array<number>(11).fill(0)];
describe('2026 individual activity estimates', () => {
  it('retains the full 30% allowance in take-home and counts monthly PSD only once', () => {
    const c = calculateTax(2026, revenue(3000000), settings());
    expect(c).toMatchObject({
      revenue: 3000000,
      deduction: 900000,
      profit: 2100000,
      base: 1890000,
      gpm: 119000,
      vsd: 236628,
      psd: 131922,
      psdMinimum: 96576,
      total: 487550,
      net: 2512450,
      monthlyAverage: 209371,
    });
    expect(c.psd! - 12 * 8048).toBe(35346);
  });
  it('matches VMI credit examples and marginal-band boundaries', () => {
    expect(gpmForProfit(30000000n, true)).toBe(350000);
    expect(gpmForProfit(20000000n, true)).toBe(100000);
    expect(gpmForProfit(42500000n, true)).toBe(850000);
    expect(gpmForProfit(45000000n, true)).toBe(900000);
    expect(gpmForProfit(83237400n, true)).toBe(1664748);
    expect(gpmForProfit(138729000n, true)).toBe(3052038);
    expect(gpmForProfit(138729100n, true)).toBe(3052041);
    for (const threshold of [20000000n, 42500000n, 83237400n, 138729000n]) {
      expect(gpmForProfit(threshold - 10n, true)).toBeLessThanOrEqual(
        gpmForProfit(threshold, true)!,
      );
      expect(gpmForProfit(threshold + 10n, true)).toBeGreaterThanOrEqual(
        gpmForProfit(threshold, true)!,
      );
    }
  });
  it('keeps missing estimates unavailable rather than zero', () => {
    const c = calculateTax(2026, revenue(10000000), {
      ...settings(),
      onlyActivityIncome: 'unknown',
    });
    expect(c.gpm).toBeNull();
    expect(c.vsd).not.toBeNull();
    expect(c.total).toBeNull();
    expect(c.net).toBeNull();
    expect(c.months.every((m) => m.net === null)).toBe(true);
    expect(calculateTax(2025, revenue(3000000), settings()).total).toBeNull();
    expect(
      calculateTax(2026, revenue(3000000), defaultTaxSettings()).total,
    ).toBeNull();
    expect(
      calculateTax(2026, revenue(3000000), {
        ...settings(),
        partialMonth: true,
      }).psd,
    ).toBeNull();
  });
  it('uses the PSD floor even with zero revenue and selected partial-year months', () => {
    const c = calculateTax(2026, revenue(0), settings());
    expect(c).toMatchObject({ gpm: 0, vsd: 0, psd: 96576, net: -96576 });
    expect(c.months.every((m) => m.net === -8048)).toBe(true);
    const partial = calculateTax(2026, revenue(0), {
      ...settings(),
      psdMonths: Array.from({ length: 12 }, (_, i) => i >= 9),
    });
    expect(partial.psd).toBe(24144);
    const covered = calculateTax(2026, revenue(3000000), {
      ...settings(),
      psdMonths: Array<boolean>(12).fill(false),
    });
    expect(covered.psd).toBe(131922);
  });
  it('caps the social base, not revenue', () => {
    const c = calculateTax(2026, revenue(30000000), settings());
    expect(c.base).toBe(9942245);
    expect(c.vsd).toBe(1244769);
    expect(c.psd).toBe(693969);
  });
  it('allocates exact annual cents across uneven and negative monthly corrections', () => {
    const c = calculateTax(
      2026,
      [120001, 230007, -12000, 777777, 0, 555555, 333333, 11, 40001, 0, 0, 2],
      settings(),
    );
    for (const key of ['gpm', 'vsd', 'psd', 'net'] as const)
      expect(c.months.reduce((sum, m) => sum + m[key]!, 0)).toBe(c[key]);
    expect(c.months[2].net).toBe(-20048);
    expect(allocate(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });
});
