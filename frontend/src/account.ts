import axios from 'axios'

export const api = axios.create({ headers: { 'X-Invoice-Client': 'web' } })
export interface Seller {
  name: string
  individualActivity: string
  taxNumber: string
  address: string
  bankName: string
  swift: string
  iban: string
}
export interface Buyer {
  name: string
  vatCode: string
  address: string
}
export interface Preferences {
  seller: Seller | null
  buyer: Buyer | null
  lastInvoiceNumber: string | null
  savedItems: string[]
}
export interface Account {
  capabilities?: { backupStatus: boolean }
  user: { id: number; email: string }
  preferences: Preferences
}
export const blankSeller: Seller = {
  name: '',
  individualActivity: '',
  taxNumber: '',
  address: '',
  bankName: '',
  swift: '',
  iban: '',
}
export const blankBuyer: Buyer = { name: '', vatCode: '', address: '' }
export function errorMessage(error: unknown): string {
  if (
    axios.isAxiosError(error) &&
    typeof error.response?.data?.message === 'string'
  )
    return error.response.data.message
  return 'Could not connect. Please try again.'
}
export function browserPreferences(): Partial<Preferences> | null {
  try {
    const seller = JSON.parse(localStorage.getItem('invoice_seller') || 'null')
    const buyer = JSON.parse(
      localStorage.getItem('invoice_last_buyer') || 'null',
    )
    const savedItems = JSON.parse(
      localStorage.getItem('invoice_saved_items') || '[]',
    )
    const lastInvoiceNumber = localStorage.getItem('invoice_last_number')
    const preferences: Partial<Preferences> = {}
    const strings = (value: unknown, fields: object) =>
      value &&
      typeof value === 'object' &&
      Object.keys(fields).every(
        (key) => typeof (value as Record<string, unknown>)[key] === 'string',
      )
    if (strings(seller, blankSeller))
      preferences.seller = Object.fromEntries(
        Object.keys(blankSeller).map((key) => [key, seller[key]]),
      ) as unknown as Seller
    if (strings(buyer, blankBuyer))
      preferences.buyer = Object.fromEntries(
        Object.keys(blankBuyer).map((key) => [key, buyer[key]]),
      ) as unknown as Buyer
    if (Array.isArray(savedItems) && savedItems.length)
      preferences.savedItems = savedItems.filter(
        (item): item is string => typeof item === 'string',
      )
    if (lastInvoiceNumber) preferences.lastInvoiceNumber = lastInvoiceNumber
    return Object.keys(preferences).length ? preferences : null
  } catch {
    return null
  }
}

export interface InvoicePayload {
  calculationVersion?: number
  invoiceNumber: string
  invoiceDate: string
  paymentTerm: string
  seller: Seller
  buyer: Buyer
  items: {
    description: string
    quantity: number
    unit: string
    price: number
  }[]
  additionalComment: string
}
export interface InvoiceSummary {
  id: number
  invoiceNumber: string
  invoiceDate: string
  paymentTerm: string
  buyerName: string
  total: number
  revision: number
  updatedAt: number | null
  createdAt: number
  regeneratedAt: number | null
  emailStatus: 'pending' | 'sent' | 'failed' | 'not_configured' | null
  emailSentAt: number | null
}
export function downloadZip(blob: Blob, number: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `invoice-${number}.zip`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export async function downloadError(error: unknown): Promise<string> {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      const data = JSON.parse(await error.response.data.text())
      if (typeof data.message === 'string') return data.message
    } catch {
      /* Fall back to the standard message. */
    }
  }
  return errorMessage(error)
}

export function emailStatusMessage(status: string | null | undefined): string {
  if (status === 'sent') return 'Email sent to your registration address.'
  if (status === 'failed')
    return 'Email could not be sent. You can retry from Invoice history.'
  if (status === 'pending') return 'Email is being sent.'
  if (status === 'not_configured')
    return 'Email delivery is not configured yet.'
  return ''
}
