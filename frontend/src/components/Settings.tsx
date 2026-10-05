import { useEffect, useState } from 'react'
import { api, errorMessage } from '../account'
interface BackupStatus {
  enabled: boolean; running: boolean; destinationAvailable?: boolean; lastSuccess?: number
  lastAttempt?: number; lastError?: string | null; schemaVersion?: number
  secondaryConfigured: boolean; secondaryLastSuccess?: number | null; secondaryError?: string | null
}
const date = (value?: number | null) => value ? new Date(value).toLocaleString() : 'Not yet completed'
export default function Settings() {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { data } = await api.get<BackupStatus>('/api/system/backup-status')
        if (!cancelled) { setStatus(data); setError('') }
      } catch (error) { if (!cancelled) setError(errorMessage(error)) }
      finally { if (!cancelled) setLoading(false) }
    }
    void load()
    window.addEventListener('focus', load)
    const timer = window.setInterval(() => void load(), 30000)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', load) }
  }, [])
  return <section className="section-card backup-settings" aria-label="Backup settings">
    <h2>Backups</h2>
    <p className="field-hint">Daily backups protect your saved invoices and account data while the application is running.</p>
    {loading && <p role="status">Checking your backups…</p>}
    {error && <p className="error-msg" role="alert">{error}</p>}
    {status && <>
      <dl className="summary-details">
        <div><dt>Automatic backups</dt><dd>{status.enabled ? 'Enabled' : 'Not enabled'}</dd></div>
        <div><dt>Backup storage</dt><dd>{status.destinationAvailable ? 'Available' : 'Unavailable'}</dd></div>
        <div><dt>Last successful backup</dt><dd>{date(status.lastSuccess)}</dd></div>
        <div><dt>Second destination</dt><dd>{status.secondaryConfigured ? 'Configured' : 'Not configured'}</dd></div>
        {status.secondaryConfigured && <div><dt>Last second copy</dt><dd>{date(status.secondaryLastSuccess)}</dd></div>}
      </dl>
      {status.running && <p role="status">Backup in progress…</p>}
      {status.lastError && <p className="error-msg" role="alert">{status.lastError}</p>}
      {status.secondaryError && <p className="error-msg" role="alert">{status.secondaryError}</p>}
      {status.lastSuccess && Date.now() - status.lastSuccess > 48 * 60 * 60 * 1000 && <p className="error-msg">Your latest backup is more than two days old. Check that the application and backup storage are available.</p>}
      <p className="field-hint">Local backups remain on this computer. A separately configured destination is needed to protect against losing the computer.</p>
    </>}
  </section>
}
