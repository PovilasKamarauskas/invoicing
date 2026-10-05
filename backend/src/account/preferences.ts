import { BadRequestException } from '@nestjs/common';

export interface Preferences {
  seller: Record<string, string> | null;
  buyer: Record<string, string> | null;
  lastInvoiceNumber: string | null;
  savedItems: string[];
}
export const emptyPreferences = (): Preferences => ({
  seller: null,
  buyer: null,
  lastInvoiceNumber: null,
  savedItems: [],
});
export const sellerFields = [
  'name',
  'individualActivity',
  'taxNumber',
  'address',
  'bankName',
  'swift',
  'iban',
];
export const buyerFields = ['name', 'vatCode', 'address'];
export function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || value.length > max)
    throw new BadRequestException('Invalid text field.');
  return value;
}
export function record(
  value: unknown,
  fields: string[],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid details.');
  return Object.fromEntries(fields.map((field) => [field, text(value[field])]));
}
export function validatePreferences(value: unknown): Partial<Preferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid preferences.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        !['seller', 'buyer', 'lastInvoiceNumber', 'savedItems'].includes(key),
    )
  )
    throw new BadRequestException('Unknown preference field.');
  const result: Partial<Preferences> = {};
  if ('seller' in input) result.seller = record(input.seller, sellerFields);
  if ('buyer' in input) result.buyer = record(input.buyer, buyerFields);
  if ('lastInvoiceNumber' in input)
    result.lastInvoiceNumber =
      input.lastInvoiceNumber === null
        ? null
        : text(input.lastInvoiceNumber, 100);
  if ('savedItems' in input) {
    if (!Array.isArray(input.savedItems) || input.savedItems.length > 500)
      throw new BadRequestException('Too many saved items.');
    const seen = new Set<string>();
    result.savedItems = input.savedItems
      .map((item) => text(item, 500).trim())
      .filter((item) => {
        const key = item.toLocaleLowerCase();
        if (!item || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.localeCompare(b));
  }
  return result;
}
