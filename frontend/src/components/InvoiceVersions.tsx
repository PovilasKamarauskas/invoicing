import { useEffect, useRef, useState } from 'react'
import rules from 'invoice-rules'
import { api, downloadError, downloadZip, errorMessage } from '../account'
import type { InvoicePayload } from '../account'
interface Version {
  id: number; revision: number; origin: 'baseline' | 'generated' | 'edited'
  invoiceNumber: string; invoiceDate: string; paymentTerm: string; buyerName: string
  total: number; createdAt: number; calculationVersion: number
  emailStatus: string | null; emailSentAt: number | null
}
interface Page { currentRevision: number; versions: Version[]; nextRevision: number | null }
interface Delivery {
  id: number; status: string; recipient: string; attemptedAt: number; occurredAt: number
  sentAt: number | null; origin: 'observed' | 'legacy_observation'; exactFilesAvailable: number
}
interface Details extends Version { payload: InvoicePayload; deliveries: Delivery[] }
const money = (value: number) => new Intl.NumberFormat('en-IE', {style:'currency',currency:'EUR'}).format(value)
const date = (value: number) => new Date(value).toLocaleString()
const status = (value: string | null) => value === 'sent' ? 'Sent' : value === 'failed' ? 'Failed' : value === 'pending' ? 'Started; completion not yet recorded' : value === 'not_configured' ? 'Email not configured' : 'No recorded email'

export default function InvoiceVersions({ invoiceId, revision, disabled }: { invoiceId: number; revision: number; disabled: boolean }) {
  const [page, setPage] = useState<Page | null>(null)
  const [details, setDetails] = useState<Details | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const request = useRef(0)
  useEffect(() => {
    mounted.current = true
    const sequence = request
    const n = ++sequence.current
    setLoading(true); setPage(null); setDetails(null); setBusy(false); setError(''); setNotice('')
    void api.get<Page>(`/invoice/history/${invoiceId}/versions`).then(({data}) => {
      if (mounted.current && n === sequence.current) setPage(data)
    }).catch(e => { if (mounted.current && n === sequence.current) setError(errorMessage(e)) })
      .finally(() => { if (mounted.current && n === sequence.current) setLoading(false) })
    return () => { mounted.current = false; sequence.current++ }
  }, [invoiceId, revision])
  const older = async () => {
    if (page?.nextRevision === null || page?.nextRevision === undefined) return
    const n = request.current
    setBusy(true); setError('')
    try {
      const {data} = await api.get<Page>(`/invoice/history/${invoiceId}/versions`, {params:{beforeRevision:page.nextRevision}})
      if (mounted.current && n === request.current) setPage(current => current ? {...data,versions:[...current.versions,...data.versions]} : data)
    } catch(e) { if (mounted.current && n === request.current) setError(errorMessage(e)) }
    finally { if (mounted.current && n === request.current) setBusy(false) }
  }
  const view = async (version: Version) => {
    if (details?.revision === version.revision) { setDetails(null); return }
    const n = request.current
    setBusy(true); setError('')
    try {
      const {data} = await api.get<Details>(`/invoice/history/${invoiceId}/versions/${version.revision}`)
      if (mounted.current && n === request.current) setDetails(data)
    } catch(e) { if (mounted.current && n === request.current) setError(errorMessage(e)) }
    finally { if (mounted.current && n === request.current) setBusy(false) }
  }
  const download = async (version: Version, delivery?: Delivery) => {
    const n = request.current
    setBusy(true); setError(''); setNotice('')
    try {
      const suffix = delivery ? `/deliveries/${delivery.id}/download` : '/download'
      const {data} = await api.get(`/invoice/history/${invoiceId}/versions/${version.revision}${suffix}`,{responseType:'blob'})
      if (!mounted.current || n !== request.current) return
      downloadZip(data, `${version.invoiceNumber}-v${version.revision+1}${delivery ? `-delivery-${delivery.id}` : ''}`)
      setNotice(`${delivery ? 'Attachment files' : 'Saved files'} for version ${version.revision+1} downloaded.`)
    } catch(e) { const message=await downloadError(e); if (mounted.current && n === request.current) setError(message) }
    finally { if (mounted.current && n === request.current) setBusy(false) }
  }
  const amounts = details ? rules.calculate(details.payload.items, details.calculationVersion) : null
  return <section className="invoice-versions" aria-label="Invoice versions">
    <h3>Version history</h3>
    <p className="field-hint">Each saved edit keeps a separate copy. Earlier versions do not add income to your tax summary.</p>
    {loading && <p role="status">Loading saved versions…</p>}
    {error && <p className="error-msg" role="alert">{error}</p>}
    {notice && <p className="history-notice" role="status">{notice}</p>}
    {!loading && page?.versions.length === 0 && <p>No versions are available.</p>}
    {page?.versions.map(version => <div className="version-entry" key={version.revision}>
      <div className="version-row">
        <div><strong>Version {version.revision+1} · {version.invoiceNumber}</strong>
          <span>{version.revision === page.currentRevision ? 'Current' : 'Previous'} · {version.origin === 'baseline' ? 'Saved before version tracking' : version.origin === 'edited' ? 'Edited' : 'Generated'}</span>
          <span>{date(version.createdAt)} · {version.buyerName} · {status(version.emailStatus)}</span></div>
        <strong>{money(version.total)}</strong>
        <div className="version-actions">
          <button className="btn btn-secondary" disabled={disabled || busy || loading} aria-expanded={details?.revision === version.revision}
            aria-label={`Details for version ${version.revision+1}`} onClick={() => void view(version)}>{details?.revision === version.revision ? 'Hide details' : 'Details'}</button>
          <button className="btn btn-secondary" disabled={disabled || busy || loading} aria-label={`Download version ${version.revision+1}`} onClick={() => void download(version)}>Download version</button>
        </div>
      </div>
      {version.origin === 'baseline' && <p className="field-hint">This is the first retained snapshot. Previously overwritten edits and their files cannot be recovered.</p>}
      {details?.revision === version.revision && <div className="version-details">
        <dl className="version-metadata">
          <div><dt>Invoice date</dt><dd>{details.invoiceDate}</dd></div>
          <div><dt>Payment due</dt><dd>{details.paymentTerm}</dd></div>
          <div><dt>Seller</dt><dd>{details.payload.seller.name}<br/>{details.payload.seller.address}<br/>Activity: {details.payload.seller.individualActivity || '—'}<br/>Tax number: {details.payload.seller.taxNumber || '—'}<br/>Bank: {details.payload.seller.bankName || '—'}<br/>SWIFT: {details.payload.seller.swift || '—'}<br/>IBAN: {details.payload.seller.iban || '—'}</dd></div>
          <div><dt>Buyer</dt><dd>{details.payload.buyer.name}<br/>{details.payload.buyer.address}<br/>VAT: {details.payload.buyer.vatCode || '—'}</dd></div>
        </dl>
        <div className="items-table-scroll"><table className="items-table"><thead><tr><th>Description</th><th>Quantity</th><th>Unit</th><th>Price</th><th>Subtotal</th></tr></thead>
          <tbody>{details.payload.items.map((item,index) => <tr key={index}><td>{item.description}</td><td>{item.quantity}</td><td>{item.unit}</td><td>{money(item.price)}</td><td>{money(amounts!.lines[index])}</td></tr>)}</tbody></table></div>
        {details.payload.additionalComment && <p className="history-comment">{details.payload.additionalComment}</p>}
        <h4>Email history for this version</h4>
        {!details.deliveries.length && <p className="field-hint">No recorded email attempts.</p>}
        {details.deliveries.map(delivery => <div className="version-delivery" key={delivery.id}>
          <p><strong>{status(delivery.status)}</strong> · {date(delivery.attemptedAt)}<br/>{delivery.recipient}
            {delivery.sentAt && <><br/>{delivery.origin === 'legacy_observation' ? 'Last known successful send' : 'Sent'}: {date(delivery.sentAt)}</>}
            {delivery.origin === 'legacy_observation' && <><br/>Earlier delivery record; exact attachment files were not retained.</>}
          </p>
          {!!delivery.exactFilesAvailable && <button className="btn btn-secondary" disabled={disabled || busy || loading} onClick={() => void download(version,delivery)} aria-label={`Download attachment files for delivery ${delivery.id}`}>Attachment files</button>}
        </div>)}
        {!!details.deliveries.length && <p className="field-hint">Sent means the email provider accepted the message. Attachment files preserve exactly what was supplied for that attempt.</p>}
      </div>}
    </div>)}
    {page?.nextRevision !== null && page?.nextRevision !== undefined && <button className="btn btn-secondary" disabled={disabled || busy || loading} onClick={() => void older()}>Load older versions</button>}
  </section>
}
