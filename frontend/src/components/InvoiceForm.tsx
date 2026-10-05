import { useEffect, useRef, useState } from 'react'
import rules from 'invoice-rules'
import {
  api,
  blankSeller,
  blankBuyer,
  downloadZip,
  downloadError,
  emailStatusMessage,
} from '../account'
import type { Preferences, InvoicePayload } from '../account'
import LineItems from './LineItems'
import Icon from './Icon'
import type { LineItemDto } from './LineItems'

function today(): string {
  return rules.localDate()
}

function addDays(dateStr: string, days: number): string {
  return rules.addDays(dateStr, days)
}

interface Props {
  editing?: { id: number; revision: number; payload: InvoicePayload }
  onEdited?: () => void
  onBusyChange?: (busy: boolean) => void
  active: boolean
  preferences: Preferences
  onSave: (patch: Partial<Preferences>) => Promise<void>
  onSaveItem: (description: string) => Promise<string[]>
  onGenerated: (number: string) => void
}

export default function InvoiceForm({
  active,
  editing,
  onEdited,
  onBusyChange,
  preferences,
  onSave,
  onSaveItem,
  onGenerated,
}: Props) {
  const [seller, setSeller] = useState(() => editing?.payload.seller || preferences.seller || blankSeller)
  const [buyer, setBuyer] = useState(() => editing?.payload.buyer || preferences.buyer || blankBuyer)
  const [invoiceNumber, setInvoiceNumber] = useState(editing?.payload.invoiceNumber || 'SF 1')
  const [invoiceDate, setInvoiceDate] = useState(() => editing?.payload.invoiceDate || today())
  const [paymentTerm, setPaymentTerm] = useState(() => editing?.payload.paymentTerm || addDays(today(), 30))
  const [items, setItems] = useState<LineItemDto[]>(editing?.payload.items || [
    { description: '', quantity: rules.workingDays(), unit: 'd', price: 0 },
  ])
  const [comment, setComment] = useState(editing?.payload.additionalComment ?? 'Reverse charge')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailNotice, setEmailNotice] = useState('')
  const [success, setSuccess] = useState(false)
  const [autoNumber, setAutoNumber] = useState(!editing)
  const [dueEdited, setDueEdited] = useState(!!editing)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [issued, setIssued] = useState<{ id: number; number: string } | null>(null)
  const attempt = useRef<{ serialized: string; key: string } | null>(null)
  const [numberLoading, setNumberLoading] = useState(false)
  useEffect(() => {
    if (!active || !autoNumber || loading || attempt.current) return
    let cancelled = false
    const refresh = async () => {
      if (attempt.current) return
      setNumberLoading(true)
      try {
        const { data } = await api.get<{ invoiceNumber: string }>('/invoice/next-number')
        if (!cancelled) setInvoiceNumber(data.invoiceNumber)
      } catch (error) {
        if (!cancelled) setError(await downloadError(error))
      } finally { if (!cancelled) setNumberLoading(false) }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.removeEventListener('focus', refresh); setNumberLoading(false) }
  }, [active, autoNumber, loading])

  const handleGenerate = async () => {
    setError(null)
    setSuccess(false)
    setEmailNotice('')
    setLoading(true)
    onBusyChange?.(true)
    try {
      const payload = {
        invoiceNumber,
        invoiceDate,
        paymentTerm,
        seller,
        buyer,
        items,
        additionalComment: comment,
        autoNumber,
      }
      const errors = rules.validateInvoice(payload)
      setFieldErrors(errors)
      if (Object.keys(errors).length) {
        setError('Please correct the highlighted fields.')
        return
      }
      const body = editing ? { ...payload, revision: editing.revision } : payload
      const serialized = JSON.stringify(body)
      if (attempt.current?.serialized !== serialized) attempt.current = { serialized, key: crypto.randomUUID() }
      const response = await api.request({
        method: editing ? 'PUT' : 'POST',
        url: editing ? `/invoice/history/${editing.id}` : '/invoice/generate',
        data: body,
        responseType: 'blob',
        headers: { 'Idempotency-Key': attempt.current!.key },
      })
      const number = decodeURIComponent(response.headers['x-invoice-number'] || encodeURIComponent(invoiceNumber))
      if (editing) {
        downloadZip(response.data, number)
        onEdited?.()
        return
      }
      attempt.current = null
      setInvoiceNumber(rules.nextNumber(number))
      setAutoNumber(true)
      setIssued({ id: Number(response.headers['x-invoice-id']), number })
      onGenerated(number)
      downloadZip(response.data, number)
      setEmailNotice(
        emailStatusMessage(response.headers['x-invoice-email-status']),
      )
      setSuccess(true)
    } catch (e: unknown) {
      setError(await downloadError(e))
    } finally {
      setLoading(false)
      onBusyChange?.(false)
    }
  }
  const downloadLastInvoice = async () => {
    if (!issued) return
    setLoading(true)
    setError(null)
    onBusyChange?.(true)
    try {
      const { data } = await api.get<{ invoiceNumber: string }>(`/invoice/history/${issued.id}`)
      const response = await api.get(`/invoice/history/${issued.id}/download`, { responseType: 'blob' })
      downloadZip(response.data, data.invoiceNumber)
    } catch (error) { setError(await downloadError(error)) }
    finally { setLoading(false); onBusyChange?.(false) }
  }

  const newInvoice = async () => {
    setLoading(true)
    try {
      const { data } = await api.get<{ invoiceNumber: string }>('/invoice/next-number')
      setInvoiceNumber(data.invoiceNumber)
      setAutoNumber(true)
      setInvoiceDate(today())
      setPaymentTerm(addDays(today(), 30))
      setDueEdited(false)
      setItems([{ description: '', quantity: rules.workingDays(), unit: 'd', price: 0 }])
      setComment('Reverse charge')
      setIssued(null)
      setSuccess(false)
      setError(null)
      setFieldErrors({})
      setEmailNotice('')
      attempt.current = null
    } catch (error) { setError(await downloadError(error)) }
    finally { setLoading(false) }
  }

  const updateSeller = (field: keyof typeof seller, value: string) => {
    const next = { ...seller, [field]: value }
    setSeller(next)
    if (!editing) void onSave({ seller: next }).catch(() => {})
  }

  const updateBuyer = (field: keyof typeof buyer, value: string) => {
    const next = { ...buyer, [field]: value }
    setBuyer(next)
    if (!editing) void onSave({ buyer: next }).catch(() => {})
  }

  let total = 0
  try { total = rules.calculate(items).total } catch { /* Validation explains invalid amounts. */ }
  const currency = new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
  })

  const fieldId = (n: number) => `${editing ? 'history-' : ''}invoice-field-${n}`

  return (
    <div className="invoice-layout">
      <fieldset className="invoice-editor invoice-fieldset" disabled={loading}>
        {/* Invoice Metadata */}
        <div className="section-card">
          <div className="section-heading">
            <span className="section-number">01</span>
            <div>
              <h2>Invoice details</h2>
              <p>The essentials for this invoice.</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label htmlFor={fieldId(1)}>Invoice Number</label>
              <input
                id={fieldId(1)}
                type="text"
                value={invoiceNumber}
                aria-invalid={!!fieldErrors.invoiceNumber}
                onChange={(e) => { setInvoiceNumber(e.target.value); setAutoNumber(false) }}
              />
              <p className="field-hint">{editing ? 'Keep this number or choose one not used by another invoice.' : autoNumber ? 'Next number follows your current invoice history.' : 'Custom number. Numbers still in history cannot be reused.'}</p>
              {fieldErrors.invoiceNumber && <p className="error-msg">{fieldErrors.invoiceNumber}</p>}
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(2)}>Invoice Date</label>
              <input
                id={fieldId(2)}
                type="date"
                value={invoiceDate}
                aria-invalid={!!fieldErrors.invoiceDate}
                onChange={(e) => { setInvoiceDate(e.target.value); if (!dueEdited) setPaymentTerm(addDays(e.target.value, 30)) }}
              />
              {fieldErrors.invoiceDate && <p className="error-msg">{fieldErrors.invoiceDate}</p>}
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(3)}>Payment due</label>
              <input
                id={fieldId(3)}
                type="date"
                value={paymentTerm}
                aria-invalid={!!fieldErrors.paymentTerm}
                onChange={(e) => { setPaymentTerm(e.target.value); setDueEdited(true) }}
              />
              {fieldErrors.paymentTerm && <p className="error-msg">{fieldErrors.paymentTerm}</p>}
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(4)}>Additional Comment</label>
              <input
                id={fieldId(4)}
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Seller */}
        <div className="section-card">
          <div className="section-heading">
            <span className="section-number">02</span>
            <div>
              <h2>Seller details</h2>
              <p>Your business and payment information.</p>
            </div>
            <span className="saved-badge">{editing ? 'Saved invoice details' : 'Saved to your account'}</span>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label htmlFor={fieldId(5)}>Name</label>
              <input
                id={fieldId(5)}
                type="text"
                value={seller.name}
                aria-invalid={!!fieldErrors['seller.name']}
                onChange={(e) => updateSeller('name', e.target.value)}
              />
              {fieldErrors['seller.name'] && <p className="error-msg">{fieldErrors['seller.name']}</p>}
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(6)}>Individual Activity No.</label>
              <input
                id={fieldId(6)}
                type="text"
                value={seller.individualActivity}
                onChange={(e) =>
                  updateSeller('individualActivity', e.target.value)
                }
              />
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(7)}>Tax Registration Number</label>
              <input
                id={fieldId(7)}
                type="text"
                value={seller.taxNumber}
                onChange={(e) => updateSeller('taxNumber', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(8)}>Bank Name</label>
              <input
                id={fieldId(8)}
                type="text"
                value={seller.bankName}
                onChange={(e) => updateSeller('bankName', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(9)}>SWIFT</label>
              <input
                id={fieldId(9)}
                type="text"
                value={seller.swift}
                onChange={(e) => updateSeller('swift', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(10)}>IBAN</label>
              <input
                id={fieldId(10)}
                type="text"
                value={seller.iban}
                onChange={(e) => updateSeller('iban', e.target.value)}
              />
            </div>
            <div className="form-group full-width">
              <label htmlFor={fieldId(11)}>Address</label>
              <input
                id={fieldId(11)}
                type="text"
                value={seller.address}
                onChange={(e) => updateSeller('address', e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Buyer */}
        <div className="section-card">
          <div className="section-heading">
            <span className="section-number">03</span>
            <div>
              <h2>Buyer details</h2>
              <p>Who are you billing?</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label htmlFor={fieldId(12)}>Company Name</label>
              <input
                id={fieldId(12)}
                type="text"
                value={buyer.name}
                aria-invalid={!!fieldErrors['buyer.name']}
                onChange={(e) => updateBuyer('name', e.target.value)}
                placeholder="Buyer company"
              />
              {fieldErrors['buyer.name'] && <p className="error-msg">{fieldErrors['buyer.name']}</p>}
            </div>
            <div className="form-group">
              <label htmlFor={fieldId(13)}>VAT Code</label>
              <input
                id={fieldId(13)}
                type="text"
                value={buyer.vatCode}
                onChange={(e) => updateBuyer('vatCode', e.target.value)}
                placeholder="VAT number"
              />
            </div>
            <div className="form-group full-width">
              <label htmlFor={fieldId(14)}>Address</label>
              <input
                id={fieldId(14)}
                type="text"
                value={buyer.address}
                onChange={(e) => updateBuyer('address', e.target.value)}
                placeholder="Street, city, country"
              />
            </div>
          </div>
        </div>

        {/* Line Items */}
        <div className="section-card">
          <div className="section-heading">
            <span className="section-number">04</span>
            <div>
              <h2>Services &amp; items</h2>
              <p>Add your work and set the rate.</p>
            </div>
          </div>
          <LineItems
            items={items}
            onChange={setItems}
            savedItems={preferences.savedItems}
            onSaveItem={onSaveItem}
            errors={fieldErrors}
          />
        </div>
      </fieldset>
      <aside className="invoice-sidebar" aria-label="Invoice summary">
        <div className="summary-card">
          <div className="summary-heading">
            <span className="summary-icon">
              <Icon name="document" />
            </span>
            <div>
              <h2>Invoice summary</h2>
              <p>Updates as you go</p>
            </div>
          </div>
          <div className="summary-number">
            {invoiceNumber || 'New invoice'}
            <span>EUR</span>
          </div>
          <dl className="summary-details">
            <div>
              <dt>From</dt>
              <dd>{seller.name || 'Add seller details'}</dd>
            </div>
            <div>
              <dt>Bill to</dt>
              <dd>{buyer.name || 'Add buyer details'}</dd>
            </div>
            <div>
              <dt>Invoice date</dt>
              <dd>{invoiceDate || '—'}</dd>
            </div>
            <div>
              <dt>Payment due</dt>
              <dd>{paymentTerm || '—'}</dd>
            </div>
            <div>
              <dt>Line items</dt>
              <dd>{items.length}</dd>
            </div>
          </dl>
          <div className="summary-total">
            <span>Total amount</span>
            <strong>{currency.format(total)}</strong>
            <p>Currency: Euro (EUR)</p>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={loading || (autoNumber && numberLoading)}
          >
            <Icon name="download" />
            {loading ? 'Please wait…' : editing ? 'Save changes & download' : 'Generate invoice ZIP'}
          </button>
          {issued && <button className="btn btn-secondary new-invoice-button" disabled={loading} onClick={() => void downloadLastInvoice()}>Download last invoice</button>}
          {issued && <button className="btn btn-secondary new-invoice-button" disabled={loading} onClick={() => void newInvoice()}>New invoice</button>}
          <p className="download-note">Two A4 PDFs. One ZIP download.</p>
          {editing && <p className="download-note">Saving replaces this invoice’s details and PDFs, and updates tax summaries. Use Email me in history to send the updated invoice.</p>}
          {error && (
            <p className="error-msg" role="alert">
              Error: {error}
            </p>
          )}
          {success && (
            <p className="success-msg" role="status">
              <Icon name="check" /> {issued?.number} saved to your history. Download started. You can adjust the form and generate the next invoice.
            </p>
          )}
          {emailNotice && (
            <p className="invoice-email-notice" role="status">
              {emailNotice}
            </p>
          )}
        </div>
        <div className="export-note">
          <span className="export-note-icon">
            <Icon name="check" />
          </span>
          <div>
            <h3>Ready in two languages</h3>
            <p>
              English and Lithuanian versions are generated together, with the
              total written in words.
            </p>
          </div>
        </div>
      </aside>
    </div>
  )
}
