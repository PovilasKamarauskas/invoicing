declare const rules: {
  calculate(
    items: { price: number; quantity: number }[],
    version?: number,
  ): { lines: number[]; total: number; totalCents?: number };
  lineCents(item: { price: number; quantity: number }): number;
  validDate(value: unknown): boolean;
  localDate(date?: Date): string;
  addDays(value: string, days: number): string;
  nextNumber(last: string | null): string;
  workingDays(date?: Date): number;
  validateInvoice(data: {
    invoiceNumber: string;
    invoiceDate: string;
    paymentTerm: string;
    seller: { name: string };
    buyer: { name: string };
    items: {
      description: string;
      unit: string;
      quantity: number;
      price: number;
    }[];
  }): Record<string, string>;
};
export = rules;
