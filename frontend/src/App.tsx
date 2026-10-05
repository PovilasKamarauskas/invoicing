import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import './App.css'
import Settings from './components/Settings'
import InvoiceHistory from './components/InvoiceHistory'
import InvoiceForm from './components/InvoiceForm'
import AuthForm from './components/AuthForm'
import YearlyTaxes from './components/YearlyTaxes'
import Icon from './components/Icon'
import { api, errorMessage } from './account'
import type { Account, Preferences } from './account'

function App() {
  const [view, setView] = useState<'new' | 'history' | 'taxes' | 'settings'>('new')
  const [historyBusy, setHistoryBusy] = useState(false)
  const [taxBusy, setTaxBusy] = useState(false)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [account, setAccount] = useState<Account | null>(null)
  const [checking, setChecking] = useState(true)
  const [connectionError, setConnectionError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [pending, setPending] = useState(0)
  const [loggingOut, setLoggingOut] = useState(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const accountEpoch = useRef(0)

  const checkSession = async () => {
    setChecking(true)
    setConnectionError('')
    try {
      setAccount((await api.get<Account>('/api/auth/me')).data)
    } catch (error) {
      if (!axios.isAxiosError(error) || error.response?.status !== 401)
        setConnectionError(errorMessage(error))
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void checkSession()
    const interceptor = api.interceptors.response.use(
      (response) => response,
      (error) => {
        if (
          error.response?.status === 401 &&
          !/\/auth\/(login|register|me)$/.test(error.config?.url || '')
        ) {
          accountEpoch.current++
          setAccount(null)
          setSaveError('')
        }
        return Promise.reject(error)
      },
    )
    return () => api.interceptors.response.eject(interceptor)
  }, [])

  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    setPending((count) => count + 1)
    const epoch = accountEpoch.current
    const result = queue.current
      .catch(() => {})
      .then(async () => {
        if (epoch !== accountEpoch.current) throw new Error('Account changed.')
        return work()
      })
    queue.current = result
    return result.finally(() => setPending((count) => count - 1))
  }
  const savePreferences = (patch: Partial<Preferences>): Promise<void> => {
    const epoch = accountEpoch.current
    setAccount((current) =>
      current
        ? { ...current, preferences: { ...current.preferences, ...patch } }
        : current,
    )
    return enqueue(async () => {
      try {
        await api.put('/api/preferences', patch)
      } catch (error) {
        if (epoch === accountEpoch.current) setSaveError(errorMessage(error))
        throw error
      }
    })
  }
  const saveItem = (description: string): Promise<string[]> =>
    enqueue(async () => {
      const userId = account?.user.id
      const { data } = await api.post<string[]>('/api/saved-items', {
        description,
      })
      setAccount((current) =>
        current && current.user.id === userId
          ? {
              ...current,
              preferences: { ...current.preferences, savedItems: data },
            }
          : current,
      )
      return data
    })
  const retrySave = async () => {
    if (!account) return
    try {
      const { seller, buyer } = account.preferences
      await savePreferences({
        ...(seller ? { seller } : {}),
        ...(buyer ? { buyer } : {}),
      })
      setSaveError('')
    } catch {
      /* The save error remains visible. */
    }
  }
  const logout = async () => {
    setLoggingOut(true)
    try {
      await queue.current
      await api.post('/api/auth/logout')
      accountEpoch.current++
      setAccount(null)
      setSaveError('')
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-icon">
              <Icon name="document" />
            </span>{' '}
            Invoice<span className="brand-light">studio</span>
          </div>
          {account ? (
            <div className="account-controls">
              <span className="account-email">{account.user.email}</span>
              <button
                className="btn btn-secondary"
                onClick={logout}
                disabled={pending > 0 || taxBusy || historyBusy || loggingOut || !!saveError}
              >
                {loggingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          ) : (
            <span className="header-note">Your invoicing workspace</span>
          )}
        </div>
      </header>
      {checking ? (
        <main>
          <p className="session-loading" role="status">
            Opening your workspace…
          </p>
        </main>
      ) : connectionError ? (
        <main>
          <div className="auth-card">
            <p className="error-msg" role="alert">
              {connectionError}
            </p>
            <button className="btn btn-primary" onClick={checkSession}>
              Try again
            </button>
          </div>
        </main>
      ) : !account ? (
        <AuthForm
          onAuthenticated={(value) => {
            accountEpoch.current++
            setView('new')
            setAccount(value)
            setSaveError('')
          }}
        />
      ) : (
        <main>
          <div className="breadcrumb">
            Workspace <Icon name="arrow" />{' '}
            <span>{view === 'new' ? 'New invoice' : view === 'taxes' ? 'Yearly taxes' : view === 'settings' ? 'Settings' : 'Invoice history'}</span>
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">SIMPLE, EVERYDAY INVOICING</p>
              <h1>
                {view === 'new' ? 'Create an invoice' : view === 'taxes' ? 'Your year, after taxes' : view === 'settings' ? 'Your settings' : 'Invoice history'}
              </h1>
              <p>
                {view === 'new'
                  ? 'Add the details. We’ll take care of the documents.'
                  : view === 'settings' ? 'Check the backups protecting your saved work.' : view === 'taxes' ? 'See your income, estimated taxes and theoretical monthly take-home.' : 'Find, edit, download, and regenerate your saved invoices.'}
              </p>
            </div>
            {view !== 'taxes' && view !== 'settings' && <span className="format-badge">
              <Icon name="document" /> English + Lithuanian PDFs
            </span>}
          </div>
          <div className="account-save-status" role="status">
            {pending
              ? 'Saving to your account…'
              : saveError
                ? 'Some details could not be saved.'
                : view === 'taxes' ? 'Tax settings and payment records are stored in your account.' : 'Your details and saved items are stored in your account.'}
          </div>
          {saveError && (
            <div className="save-error" role="alert">
              {saveError}
              <button
                className="btn btn-secondary"
                onClick={retrySave}
                disabled={pending > 0}
              >
                Retry save
              </button>
            </div>
          )}
          <nav className="workspace-tabs" aria-label="Workspace views">
            <button
              type="button"
              className={view === 'new' ? 'is-current' : ''}
              aria-current={view === 'new' ? 'page' : undefined}
              onClick={() => setView('new')}
              disabled={taxBusy || historyBusy}
            >
              New invoice
            </button>
            <button
              type="button"
              className={view === 'history' ? 'is-current' : ''}
              aria-current={view === 'history' ? 'page' : undefined}
              onClick={() => setView('history')}
              disabled={taxBusy || historyBusy}
            >
              Invoice history
            </button>
            <button type="button" className={view === 'taxes' ? 'is-current' : ''} aria-current={view === 'taxes' ? 'page' : undefined} onClick={() => setView('taxes')} disabled={taxBusy || historyBusy}>Yearly taxes</button>
            {account.capabilities?.backupStatus && <button type="button" className={view === 'settings' ? 'is-current' : ''} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')} disabled={taxBusy || historyBusy}>Settings</button>}
          </nav>
          <div hidden={view !== 'new'}>
            <InvoiceForm
              active={view === 'new'}
              key={account.user.id}
              preferences={account.preferences}
              onSave={savePreferences}
              onSaveItem={saveItem}
              onGenerated={(number) => {
                const userId = account.user.id
                setAccount((current) =>
                  current?.user.id === userId
                    ? {
                        ...current,
                        preferences: {
                          ...current.preferences,
                          lastInvoiceNumber: number,
                        },
                      }
                    : current,
                )
                setHistoryRevision((revision) => revision + 1)
              }}
            />
          </div>
          {view === 'history' && (
            <InvoiceHistory key={account.user.id} revision={historyRevision} preferences={account.preferences} onSaveItem={saveItem} onBusyChange={setHistoryBusy} />
          )}
          {view === 'taxes' && <YearlyTaxes key={account.user.id} onBusyChange={setTaxBusy} />}
          {view === 'settings' && account.capabilities?.backupStatus && <Settings />}
          <footer className="app-footer">
            Invoice studio <span>Made for your next invoice.</span>
          </footer>
        </main>
      )}
    </div>
  )
}

export default App
