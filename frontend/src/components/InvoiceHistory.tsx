import { useEffect, useRef, useState } from 'react'
import {
  api,
  downloadZip,
  downloadError,
  errorMessage,
  emailStatusMessage,
} from '../account'
import type { InvoicePayload, InvoiceSummary, Preferences } from '../account'
import Icon from './Icon'
import InvoiceForm from './InvoiceForm'
import InvoiceVersions from './InvoiceVersions'
import rules from 'invoice-rules'

interface HistoryPage {
  invoices: InvoiceSummary[]
  nextCursor: number | null
}
interface Details extends InvoiceSummary {
  payload: InvoicePayload
}
const currency = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
})

interface Props {
  revision: number
  preferences: Preferences
  onSaveItem: (description: string) => Promise<string[]>
  onBusyChange: (busy: boolean) => void
}
export default function InvoiceHistory({ revision, preferences, onSaveItem, onBusyChange }: Props) {
  const [versionsId, setVersionsId] = useState<number | null>(null)
  const [editing, setEditing] = useState<Details | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  useEffect(() => { onBusyChange(editBusy) }, [editBusy, onBusyChange])

  const [invoices, setInvoices] = useState<InvoiceSummary[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [pendingDeletion, setPendingDeletion] = useState<InvoiceSummary | null>(
    null,
  )
  const cancelDelete = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (pendingDeletion) cancelDelete.current?.focus()
  }, [pendingDeletion])
  const [details, setDetails] = useState<Details | null>(null)
  const mounted = useRef(false)
  const sequence = useRef(0)

  const load = async (before?: number) => {
    const request = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get<HistoryPage>('/invoice/history', {
        params: before ? { before } : {},
      })
      if (!mounted.current || request !== sequence.current) return
      setInvoices((current) =>
        before ? [...current, ...data.invoices] : data.invoices,
      )
      setNextCursor(data.nextCursor)
    } catch (error) {
      if (mounted.current && request === sequence.current)
        setError(errorMessage(error))
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      // This counter invalidates requests when the component is unmounted.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++
    }
  }, [revision])

  const action = async (
    invoice: InvoiceSummary,
    kind: 'download' | 'regenerate' | 'details' | 'email' | 'delete' | 'edit',
  ) => {
    setBusy(invoice.id)
    setError('')
    setNotice('')
    try {
      if (kind === 'edit') {
        const { data } = await api.get<Details>(`/invoice/history/${invoice.id}`)
        if (mounted.current) { setEditing(data); setVersionsId(null); setDetails(null); setPendingDeletion(null) }
      } else if (kind === 'delete') {
        await api.delete(`/invoice/history/${invoice.id}`)
        if (!mounted.current) return
        setInvoices((current) => current.filter((row) => row.id !== invoice.id))
        setDetails((current) => (current?.id === invoice.id ? null : current))
        setPendingDeletion(null)
        setVersionsId(current => current === invoice.id ? null : current)
        setNotice(`${invoice.invoiceNumber} deleted from your history.`)
        if (invoices.length === 1 && nextCursor) await load(nextCursor)
      } else if (kind === 'details') {
        if (details?.id === invoice.id) {
          setDetails(null)
          return
        }
        const { data } = await api.get<Details>(
          `/invoice/history/${invoice.id}`,
        )
        if (mounted.current) setDetails(data)
      } else if (kind === 'email') {
        const { data } = await api.post<{ sentAt: number; recipient: string }>(
          `/invoice/history/${invoice.id}/email`,
        )
        if (!mounted.current) return
        setNotice(`${invoice.invoiceNumber}: email sent to ${data.recipient}.`)
        setInvoices((current) =>
          current.map((row) =>
            row.id === invoice.id
              ? { ...row, emailStatus: 'sent', emailSentAt: data.sentAt }
              : row,
          ),
        )
      } else {
        const url = `/invoice/history/${invoice.id}/${kind}`
        const response =
          kind === 'regenerate'
            ? await api.post(url, {}, { responseType: 'blob' })
            : await api.get(url, { responseType: 'blob' })
        if (!mounted.current) return
        downloadZip(response.data, invoice.invoiceNumber)
        setNotice(
          `${invoice.invoiceNumber}: ${kind === 'regenerate' ? 'regenerated from saved details' : 'saved files downloaded'}.`,
        )
        if (kind === 'regenerate') {
          setNotice(
            `${invoice.invoiceNumber}: regenerated from saved details. ${emailStatusMessage(response.headers['x-invoice-email-status'])}`,
          )
          setInvoices((current) =>
            current.map((row) =>
              row.id === invoice.id
                ? {
                    ...row,
                    regeneratedAt: Date.now(),
                    emailStatus:
                      response.headers['x-invoice-email-status'] || null,
                    ...(response.headers['x-invoice-email-status'] === 'sent'
                      ? { emailSentAt: Date.now() }
                      : {}),
                  }
                : row,
            ),
          )
        }
      }
    } catch (error) {
      const message = await downloadError(error)
      if (mounted.current) setError(message)
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  if (editing) return (
    <section aria-label="Edit saved invoice">
      <div className="history-heading">
        <div><h2>Edit {editing.invoiceNumber}</h2><p>Changes apply to this saved invoice.</p></div>
        <button className="btn btn-secondary" disabled={editBusy} onClick={() => setEditing(null)}>Cancel editing</button>
      </div>
      <InvoiceForm key={`${editing.id}-${editing.revision}`} active preferences={preferences}
        editing={editing} onSave={async () => {}} onSaveItem={onSaveItem} onGenerated={() => {}}
        onBusyChange={setEditBusy} onEdited={() => { setEditing(null); setNotice('Invoice updated. New files downloaded.'); void load() }} />
    </section>
  )

  return (
    <section
      className="section-card invoice-history"
      aria-label="Invoice history"
    >
      <div className="history-heading">
        <div>
          <h2>Your invoices</h2>
          <p>Saved documents and the details used to create them.</p>
        </div>
        <button
          className="btn btn-secondary"
          onClick={() => void load()}
          disabled={loading || busy !== null}
        >
          Refresh
        </button>
      </div>
      {notice && (
        <p className="history-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="error-msg" role="alert">
          {error}{' '}
          <button
            className="btn btn-secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            Try again
          </button>
        </div>
      )}
      {loading && !invoices.length ? (
        <p className="history-empty" role="status">
          Loading your invoices…
        </p>
      ) : !invoices.length && !error ? (
        <div className="history-empty">
          <Icon name="document" />
          <h3>No invoices yet</h3>
          <p>
            Generate your first invoice and it will be saved here automatically.
          </p>
        </div>
      ) : (
        invoices.map((invoice) => (
          <article className="history-entry" key={invoice.id}>
            <div className="history-row">
              <div className="history-invoice">
                <strong>{invoice.invoiceNumber}</strong>
                <span>{invoice.buyerName || 'Buyer not specified'}</span>
              </div>
              <div className="history-dates">
                <span>Issued {invoice.invoiceDate || '—'}</span>
                <span>Due {invoice.paymentTerm || '—'}</span>
              </div>
              <strong className="history-amount">
                {currency.format(invoice.total)}
              </strong>
              <div className="history-actions">
                <button className="btn btn-secondary" disabled={busy !== null || loading} aria-expanded={versionsId === invoice.id}
                  aria-label={`Versions for invoice ${invoice.invoiceNumber}`} onClick={() => setVersionsId(current => current === invoice.id ? null : invoice.id)}>
                  {versionsId === invoice.id ? 'Hide versions' : 'Versions'}
                </button>

                <button className="btn btn-secondary" onClick={() => void action(invoice, 'edit')}
                  disabled={busy !== null || loading} aria-label={`Edit invoice ${invoice.invoiceNumber}`}>Edit</button>

                <button
                  className="btn btn-secondary"
                  onClick={() => void action(invoice, 'details')}
                  disabled={busy !== null || loading}
                  aria-expanded={details?.id === invoice.id}
                >
                  {details?.id === invoice.id ? 'Hide details' : 'Details'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => void action(invoice, 'download')}
                  disabled={busy !== null || loading}
                >
                  <Icon name="download" /> Download
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void action(invoice, 'regenerate')}
                  disabled={busy !== null || loading}
                >
                  {busy === invoice.id ? 'Please wait…' : 'Regenerate'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => void action(invoice, 'email')}
                  disabled={busy !== null || loading}
                >
                  Email me
                </button>
                <button
                  className="btn btn-delete"
                  onClick={() => setPendingDeletion(invoice)}
                  disabled={busy !== null || loading}
                  aria-label={`Delete invoice ${invoice.invoiceNumber}`}
                >
                  <Icon name="trash" /> Delete
                </button>
              </div>
            </div>
            <p className="history-timestamp">
              Saved {new Date(invoice.createdAt).toLocaleString()}
              {invoice.updatedAt ? ` · Last edited ${new Date(invoice.updatedAt).toLocaleString()}` : ''}
              {invoice.regeneratedAt
                ? ` · Last regenerated ${new Date(invoice.regeneratedAt).toLocaleString()}`
                : ''}
            </p>
            {pendingDeletion?.id === invoice.id && (
              <div
                className="delete-confirmation"
                role="alertdialog"
                aria-labelledby={`delete-title-${invoice.id}`}
                aria-describedby={`delete-description-${invoice.id}`}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && busy === null)
                    setPendingDeletion(null)
                }}
              >
                <div>
                  <h3 id={`delete-title-${invoice.id}`}>
                    Delete {invoice.invoiceNumber}?
                  </h3>
                  <p id={`delete-description-${invoice.id}`}>
                    This permanently removes the saved invoice details, PDF
                    files, all saved versions, attachment files and email history. Its income will also be removed
                    from yearly tax summaries. This cannot be undone.
                  </p>
                </div>
                <div className="delete-confirmation-actions">
                  <button
                    ref={cancelDelete}
                    className="btn btn-secondary"
                    onClick={() => setPendingDeletion(null)}
                    disabled={busy !== null}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-delete"
                    onClick={() => void action(invoice, 'delete')}
                    disabled={busy !== null}
                  >
                    {busy === invoice.id ? 'Deleting…' : 'Delete invoice'}
                  </button>
                </div>
              </div>
            )}
            {invoice.emailStatus && (
              <p className="invoice-email-notice">
                {emailStatusMessage(invoice.emailStatus)}
                {invoice.emailSentAt
                  ? ` Last sent ${new Date(invoice.emailSentAt).toLocaleString()}.`
                  : ''}
              </p>
            )}
            {versionsId === invoice.id && <InvoiceVersions invoiceId={invoice.id} revision={invoice.revision} disabled={busy !== null || loading} />}
            {details?.id === invoice.id && (
              <div className="history-details">
                <div className="history-parties">
                  <div>
                    <h3>Seller</h3>
                    <p>{details.payload.seller.name}</p>
                    <p>{details.payload.seller.address}</p>
                    <p>
                      Activity:{' '}
                      {details.payload.seller.individualActivity || '—'}
                    </p>
                    <p>Tax number: {details.payload.seller.taxNumber || '—'}</p>
                    <p>Bank: {details.payload.seller.bankName || '—'}</p>
                    <p>SWIFT: {details.payload.seller.swift || '—'}</p>
                    <p>IBAN: {details.payload.seller.iban || '—'}</p>
                  </div>
                  <div>
                    <h3>Buyer</h3>
                    <p>{details.payload.buyer.name}</p>
                    <p>{details.payload.buyer.address}</p>
                    <p>VAT: {details.payload.buyer.vatCode || '—'}</p>
                  </div>
                </div>
                <div className="items-table-scroll">
                  <table className="items-table">
                    <thead>
                      <tr>
                        <th>Description</th>
                        <th>Quantity</th>
                        <th>Unit</th>
                        <th>Price</th>
                        <th>Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {details.payload.items.map((item, index) => (
                        <tr key={index}>
                          <td>{item.description}</td>
                          <td>{item.quantity}</td>
                          <td>{item.unit}</td>
                          <td>{currency.format(item.price)}</td>
                          <td>{currency.format(rules.calculate(details.payload.items, details.payload.calculationVersion ?? 0).lines[index])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {details.payload.additionalComment && (
                  <p className="history-comment">
                    {details.payload.additionalComment}
                  </p>
                )}
                <p className="history-retention-note">
                  Regeneration uses these saved details. Your current account
                  settings do not change this invoice.
                </p>
              </div>
            )}
          </article>
        ))
      )}
      {nextCursor && (
        <button
          className="btn btn-secondary history-more"
          onClick={() => void load(nextCursor)}
          disabled={loading || busy !== null}
        >
          {loading ? 'Loading…' : 'Load more invoices'}
        </button>
      )}
    </section>
  )
}
