import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, downloadError, errorMessage } from '../account'
import './YearlyTaxes.css'

type Category = 'GPM' | 'VSD' | 'PSD'
type Kind = Category | 'income'
interface Settings {
  profileConfirmed: boolean
  onlyActivityIncome: 'unknown' | 'yes' | 'no'
  psdMonths: boolean[]
  psdReviewed: boolean
  partialMonth: boolean
}
interface Entry { id: number; kind: Kind; year: number; date: string; amount: number; note: string }
interface Invoice { id: number; number: string; invoiceDate: string; earnedDate: string; amount: number; reviewed: number }
interface Month { month: number; revenue: number; deduction: number; gpm: number | null; vsd: number | null; psd: number | null; net: number | null }
interface Summary {
  year: number; settings: Settings; entries: Entry[]; invoices: Invoice[]
  paid: Record<Category, number>; balances: Record<Category, number | null>
  unreviewed: number; futureIncome: number; futurePsdMinimum: number | null; calculatedAt: string; revision: string
  calculation: {
    supported: boolean; complete: boolean; issues: string[]; revenue: number; deduction: number; profit: number
    base: number | null; gpm: number | null; vsd: number | null; psd: number | null; psdIncome: number | null
    psdMinimum: number | null; gpmCredit: number | null; total: number | null; availableSubtotal: number
    billedThroughMonth: number; billedMonthlyAverage: number | null; net: number | null; monthlyAverage: number | null; months: Month[]; rulesVersion: string | null
  }
}
const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
const money = (cents: number | null) => cents === null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100)
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vilnius' }).format(new Date())
const defaultEntry = (year: number) => ({ kind: 'income' as Kind, date: year === Number(today().slice(0,4)) ? today() : `${year}-01-01`, amount: '', note: '' })

export default function YearlyTaxes({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [year, setYear] = useState(2026)
  const [years, setYears] = useState<number[]>([2026])
  const [data, setData] = useState<Summary | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [entry, setEntry] = useState(defaultEntry(2026))
  const [editing, setEditing] = useState<number | null>(null)
  const [dateEdits, setDateEdits] = useState<Record<number, string>>({})
  const request = useRef(0)
  const requestKey = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const load = useCallback(async (resetSettings = false) => {
    const seq = ++request.current
    setLoading(true)
    try {
      const [summary, available] = await Promise.all([api.get<Summary>(`/api/taxes/${year}`), api.get<number[]>('/api/taxes/years')])
      if (seq !== request.current) return
      setData(summary.data)
      setYears([...new Set([...available.data, year])].sort((a,b) => b-a))
      if (resetSettings || !dirtyRef.current) {
        setSettings(summary.data.settings)
        setDirty(false)
        dirtyRef.current = false
      }
      setError('')
    } catch (e) {
      if (seq === request.current) setError(errorMessage(e))
    } finally {
      if (seq === request.current) setLoading(false)
    }
  }, [year])
  useEffect(() => {
    const sequence = request
    setData(null)
    setSettings(null)
    setDateEdits({})
    setEntry(defaultEntry(year))
    setEditing(null)
    requestKey.current = null
    dirtyRef.current = false
    setDirty(false)
    void load(true)
    const focus = () => { if (!busyRef.current) void load() }
    window.addEventListener('focus', focus)
    return () => { sequence.current++; window.removeEventListener('focus',focus) }
  }, [load, year])
  const mutate = async (work: () => Promise<unknown>, message: string) => {
    if (busyRef.current) return false
    request.current++
    busyRef.current = true
    setBusy(true)
    onBusyChange(true)
    setError('')
    setNotice('')
    try {
      await work()
      setNotice(message)
      await load()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }
  const patchSettings = (patch: Partial<Settings>) => {
    setSettings((s) => s ? { ...s, ...patch } : s)
    setDirty(true)
    dirtyRef.current = true
  }
  const saveSettings = (e: FormEvent) => {
    e.preventDefault()
    void mutate(async () => {
      await api.put(`/api/taxes/${year}/settings`,settings)
      dirtyRef.current = false
      setDirty(false)
    }, 'Tax profile saved to your account.')
  }
  const changeEntry = (patch: Partial<typeof entry>) => {
    setEntry((e) => ({ ...e, ...patch }))
    requestKey.current = null
  }
  const saveEntry = async (e: FormEvent) => {
    e.preventDefault()
    requestKey.current ??= crypto.randomUUID()
    const payload = { ...entry, requestKey: requestKey.current }
    await mutate(async () => {
      if (editing === null) await api.post(`/api/taxes/${year}/entries`,payload)
      else await api.put(`/api/taxes/${year}/entries/${editing}`,payload)
      setEntry(defaultEntry(year))
      setEditing(null)
      requestKey.current = null
    }, editing === null ? 'Record saved.' : 'Record updated.')
  }
  const exportCsv = async () => {
    if (busyRef.current) return
    setError('')
    busyRef.current = true
    setBusy(true)
    onBusyChange(true)
    try {
      const response = await api.get(`/api/taxes/${year}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(response.data)
      const link = document.createElement('a')
      link.href = url; link.download = `yearly-taxes-${year}.csv`; link.click()
      setTimeout(() => URL.revokeObjectURL(url),1000)
    } catch (e) { setError(await downloadError(e)) }
    finally { busyRef.current = false; setBusy(false); onBusyChange(false) }
  }
  const c = data?.calculation
  return <section className="tax-page" aria-label="Yearly tax summary">
    <div className="tax-toolbar">
      <label>Tax year <select aria-label="Tax year" value={year} disabled={busy || dirty} onChange={(e) => { setYear(Number(e.target.value)); setNotice('') }}>{years.map((y) => <option key={y}>{y}</option>)}</select></label>
      <div><button className="btn btn-secondary" disabled={busy || loading} onClick={() => void load()}>Refresh</button> <button className="btn btn-primary" disabled={busy || loading || !data || dirty} onClick={() => void exportCsv()}>Export CSV</button></div>
    </div>
    {error && <div className="error-msg" role="alert">{error} <button className="btn btn-secondary" disabled={busy} onClick={() => void load()}>Retry loading</button></div>}
    {notice && <p className="tax-notice" role="status">{notice}</p>}
    {loading && <p role="status">Updating your tax summary…</p>}
    {data && c && <>
      <div className="tax-cards">
        <article><span>Full invoice income</span><strong>{money(c.revenue)}</strong><small>Recognized in {year}</small></article>
        <article><span>Estimated annual taxes</span><strong>{money(c.total)}</strong><small>GPM + VSD + PSD</small></article>
        <article className="tax-card-net"><span>Theoretical annual take-home</span><strong>{money(c.net)}</strong><small>Full income minus estimated taxes</small></article>
        <article className="tax-card-net"><span>Average monthly take-home</span><strong>{money(c.monthlyAverage)}</strong><small>Calendar-year average ÷ 12</small></article>
        <article className="tax-card-net"><span>Average through latest billed month</span><strong>{money(c.billedMonthlyAverage)}</strong><small>{c.billedThroughMonth ? `January–${months[c.billedThroughMonth - 1]} · ÷ ${c.billedThroughMonth} months` : 'No billed income yet'}</small></article>

      </div>
      <p className="tax-explanation">Your 30% expense allowance reduces the tax base. It stays in your take-home because it is not treated as money spent. Both averages use the same estimated take-home: one divides by 12, the other by the months from January through the latest earned invoice or positive income adjustment. September means 9 months, even with gaps. Selected annual PSD minimums remain included. These estimates assume invoices are paid and exclude actual business expenses.</p>
      {c.issues.length > 0 && <div className="tax-callout" role="status"><strong>Complete your estimate</strong><ul>{c.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
      {dirty && <p className="tax-callout">Unsaved profile changes. The figures above use your saved settings.</p>}
      {data.futureIncome > 0 && <p className="tax-callout">{data.futureIncome} future-dated income record(s) are included in this year.</p>}
      <details className="tax-panel" open={!settings?.profileConfirmed || !settings?.psdReviewed}>
        <summary>Tax profile and PSD months</summary>
        {settings && <form onSubmit={saveSettings}>
          <fieldset disabled={busy || !c.supported}>
            <label className="tax-check"><input type="checkbox" checked={settings.profileConfirmed} onChange={(e) => patchSettings({ profileConfirmed:e.target.checked })} /> I use accrual accounting, qualify for the 30% expense method, pay no extra pension contribution and have standard Lithuanian VSD/PSD obligations.</label>
            <p className="tax-help">This profile excludes employer activity income, first-year VSD exemptions, foreign tax credits and loss carryforwards.</p>
            <label className="tax-field">Other income relevant to progressive GPM<select value={settings.onlyActivityIncome} onChange={(e) => patchSettings({ onlyActivityIncome:e.target.value as Settings['onlyActivityIncome'] })}><option value="unknown">Not reviewed</option><option value="yes">Only individual-activity income</option><option value="no">I have other relevant income</option></select></label>
            <p className="tax-help">Above €42,500 taxable profit, other income needs a broader GPM calculation. Activity income may also affect tax on other income below that threshold.</p>
            <h3>Months requiring the €80.48 PSD minimum</h3>
            <p className="tax-help">Select months with a monthly obligation, even if you earned nothing. Coverage through employment/state insurance can remove the monthly minimum, but not generally annual income-based PSD.</p>
            <div className="tax-month-checks">{months.map((name,i) => <label key={name}><input type="checkbox" checked={settings.psdMonths[i]} onChange={(e) => patchSettings({ psdMonths:settings.psdMonths.map((v,j) => j === i ? e.target.checked : v) })} />{name.slice(0,3)}</label>)}</div>
            <label className="tax-check"><input type="checkbox" checked={settings.psdReviewed} onChange={(e) => patchSettings({ psdReviewed:e.target.checked })} /> I have reviewed my activity months and monthly PSD obligations.</label>
            <label className="tax-check"><input type="checkbox" checked={settings.partialMonth} onChange={(e) => patchSettings({ partialMonth:e.target.checked })} /> I need partial-month or coverage-transition treatment (PSD estimate unavailable).</label>
            <div className="tax-form-actions"><button className="btn btn-primary" disabled={!dirty}>Save tax profile</button><button className="btn btn-secondary" type="button" disabled={!dirty} onClick={() => { setSettings(data.settings); dirtyRef.current=false; setDirty(false) }}>Discard changes</button></div>
          </fieldset>
        </form>}
      </details>
      <section className="tax-panel"><h2>Monthly take-home</h2><p className="tax-help">Annual taxes are allocated across your income months, with PSD minimums assigned to their months. Figures can change as annual income is added. This is a budgeting estimate, not a monthly assessment.</p>
        <div className="tax-table-wrap"><table><thead><tr><th>Month</th><th>Full income</th><th>30% allowance</th><th>GPM</th><th>VSD</th><th>PSD</th><th>Take-home</th></tr></thead><tbody>{c.months.map((m) => <tr key={m.month}><th>{months[m.month-1]}</th><td>{money(m.revenue)}</td><td className="tax-muted">{money(m.deduction)}</td><td>{money(m.gpm)}</td><td>{money(m.vsd)}</td><td>{money(m.psd)}</td><td className="tax-net">{money(m.net)}</td></tr>)}</tbody><tfoot><tr><th>Year total</th><td>{money(c.revenue)}</td><td>{money(c.deduction)}</td><td>{money(c.gpm)}</td><td>{money(c.vsd)}</td><td>{money(c.psd)}</td><td>{money(c.net)}</td></tr></tfoot></table></div>
      </section>
      <section className="tax-panel"><h2>Annual tax breakdown</h2><div className="tax-metrics"><p>Presumed expenses <strong>{money(c.deduction)}</strong></p><p>Taxable profit (70%) <strong>{money(c.profit)}</strong></p><p>Capped social base <strong>{money(c.base)}</strong></p><p>GPM credit <strong>{money(c.gpmCredit)}</strong></p></div>
        <div className="tax-table-wrap"><table><thead><tr><th>Tax</th><th>Annual liability</th><th>Recorded payments</th><th>Remaining estimate</th></tr></thead><tbody>{(['GPM','VSD','PSD'] as Category[]).map((kind) => <tr key={kind}><th>{kind}</th><td>{money(c[kind.toLowerCase() as 'gpm'|'vsd'|'psd'])}</td><td>{money(data.paid[kind])}</td><td>{money(data.balances[kind])}{(data.balances[kind] ?? 0) < 0 && <small> Recorded payments exceed the estimate</small>}</td></tr>)}</tbody></table></div>
        {!c.complete && <p className="tax-help">Available tax subtotal: {money(c.availableSubtotal)}. Complete totals need all three estimates.</p>}
        <p className="tax-help">VSD: 12.52% of the capped social base. PSD: the greater of income-based PSD ({money(c.psdIncome)}) and required monthly minimums ({money(c.psdMinimum)}). Monthly payments count toward PSD; they are not added again.</p>
        {(data.futurePsdMinimum ?? 0) > 0 && <p className="tax-help">{money(data.futurePsdMinimum)} of the selected PSD minimums relates to future months.</p>}
        <p className="tax-help">Remaining annual estimates are not overdue balances. Calculations use entered records without forecasting future income. Cent-based estimates may differ from whole-euro declaration rounding.</p>
      </section>
      <details className="tax-panel"><summary>Invoice income and earned dates ({data.invoices.length})</summary>
        <p className="tax-help">Based on retained invoices and entered adjustments. Deleting an invoice from history removes its income from this view. Include deleted or externally generated income with an adjustment if it still belongs in your annual totals.</p>
        {data.unreviewed > 0 && <div className="tax-inline"><p>{data.unreviewed} invoice date(s) have not been reviewed as service dates.</p><button className="btn btn-secondary" disabled={busy} onClick={() => void mutate(() => api.post(`/api/taxes/${year}/review-dates`), 'Earned dates confirmed.')}>Confirm listed dates</button></div>}
        <div className="tax-table-wrap"><table><thead><tr><th>Invoice</th><th>Invoice date</th><th>Income</th><th>Service / earned date</th><th>Review</th></tr></thead><tbody>{data.invoices.map((i) => <tr key={i.id}><th>{i.number}</th><td>{i.invoiceDate}</td><td>{money(i.amount)}</td><td><input aria-label={`Earned date ${i.number}`} type="date" value={dateEdits[i.id] ?? i.earnedDate} disabled={busy} onChange={(e) => setDateEdits((v) => ({ ...v, [i.id]:e.target.value }))} /></td><td><button className="btn btn-secondary" disabled={busy || !(dateEdits[i.id] ?? i.earnedDate)} onClick={() => void mutate(async () => { await api.put(`/api/taxes/invoices/${i.id}/earned-date`, { earnedDate:dateEdits[i.id] ?? i.earnedDate }); setDateEdits((v) => { const next={ ...v }; delete next[i.id]; return next }) }, 'Earned date saved.')}>{i.reviewed && !dateEdits[i.id] ? 'Reviewed' : 'Save date'}</button></td></tr>)}</tbody></table></div>
        {data.invoices.length === 0 && <p>No retained invoices in this year.</p>}
      </details>
      <section className="tax-panel"><h2>Income adjustments and tax payments</h2><p className="tax-help">Tax payments reduce your remaining balance, not theoretical take-home. Select the year a payment covers, even if you paid it the following year. Split combined Sodra transfers into VSD and PSD using your records.</p>
        <form onSubmit={(e) => void saveEntry(e)}><fieldset disabled={busy}><div className="tax-entry-form">
          <label>Record type<select value={entry.kind} onChange={(e) => changeEntry({ kind:e.target.value as Kind })}><option value="income">Income adjustment</option><option>GPM</option><option>VSD</option><option>PSD</option></select></label>
          <label>{entry.kind === 'income' ? 'Earned date' : 'Payment date'}<input required type="date" value={entry.date} onChange={(e) => changeEntry({ date:e.target.value })} /></label>
          <label>Amount (€)<input required inputMode="decimal" placeholder={entry.kind === 'income' ? 'Positive or negative' : 'Amount paid'} value={entry.amount} onChange={(e) => changeEntry({ amount:e.target.value })} /></label>
          <label>Reason / note<input maxLength={1000} required={entry.kind === 'income'} value={entry.note} onChange={(e) => changeEntry({ note:e.target.value })} /></label>
        </div><div className="tax-form-actions"><button className="btn btn-primary">{editing === null ? 'Add record' : 'Save record'}</button>{editing !== null && <button className="btn btn-secondary" type="button" onClick={() => { setEditing(null); setEntry(defaultEntry(year)); requestKey.current=null }}>Cancel edit</button>}</div></fieldset></form>
        <div className="tax-table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Note</th><th>Actions</th></tr></thead><tbody>{data.entries.map((e) => <tr key={e.id}><td>{e.date}</td><th>{e.kind === 'income' ? 'Income adjustment' : e.kind}</th><td>{money(e.amount)}</td><td className="tax-note-cell">{e.note}</td><td><button className="btn btn-secondary" disabled={busy} onClick={() => { setEditing(e.id); setEntry({ kind:e.kind, date:e.date, amount:(e.amount/100).toFixed(2), note:e.note }); requestKey.current=null }}>Edit</button> <button className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm('Delete this tax record?')) void mutate(() => api.delete(`/api/taxes/${year}/entries/${e.id}`), 'Record deleted.') }}>Delete</button></td></tr>)}</tbody></table></div>
        {data.entries.length === 0 && <p className="tax-help">No adjustments or tax payments recorded yet. Payments are never assumed from the monthly obligation.</p>}
      </section>
      <p className="tax-help tax-footnote">Calculated {new Date(data.calculatedAt).toLocaleString()} · {c.rulesVersion ?? 'Income totals only'} · <a href="https://www.vmi.lt/evmi/5725" target="_blank" rel="noreferrer">VMI GPM rules</a> · <a href="https://sodra.lt/imokos/vykdau-individualia-veikla" target="_blank" rel="noreferrer">Sodra contributions</a></p>
    </>}
  </section>
}
