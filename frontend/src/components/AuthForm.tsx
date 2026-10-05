import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api, browserPreferences, errorMessage } from '../account'
import type { Account } from '../account'
import Icon from './Icon'

export default function AuthForm({
  onAuthenticated,
}: {
  onAuthenticated: (account: Account) => void
}) {
  const [register, setRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [importDetails, setImportDetails] = useState(false)
  const [legacy] = useState(browserPreferences)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [registrationAllowed, setRegistrationAllowed] = useState(false)
  useEffect(() => {
    let active = true
    void api.get<{registrationEnabled: boolean}>('/api/auth/config')
      .then(({data}) => { if (active) setRegistrationAllowed(data.registrationEnabled === true) })
      .catch(() => { /* Keep login available and registration hidden if configuration cannot load. */ })
    return () => { active = false }
  }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const response = await api.post<Account>(
        `/api/auth/${register ? 'register' : 'login'}`,
        {
          email,
          password,
          ...(register && importDetails && legacy
            ? { preferences: legacy }
            : {}),
        },
      )
      onAuthenticated(response.data)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }
  return (
    <main className="auth-main">
      <div className="auth-card">
        <span className="auth-icon">
          <Icon name="document" />
        </span>
        <p className="eyebrow">YOUR INVOICING WORKSPACE</p>
        <h1>{register ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth-intro">
          {register
            ? 'Keep your details and saved items together.'
            : 'Sign in to pick up where you left off.'}
        </p>
        <form onSubmit={submit}>
          <div className="form-group">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="form-group">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              minLength={register ? 8 : 1}
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={register ? 'At least 8 characters' : 'Your password'}
            />
          </div>
          {register && legacy && (
            <label className="import-option">
              <input
                type="checkbox"
                checked={importDetails}
                onChange={(e) => setImportDetails(e.target.checked)}
              />
              Import existing details and items saved in this browser
            </label>
          )}
          {error && (
            <p className="error-msg" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" disabled={loading}>
            {loading ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
          </button>
        </form>
        {registrationAllowed && <p className="auth-switch">
          {register ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setRegister(!register)
              setError('')
              setPassword('')
            }}
          >
            {register ? 'Sign in' : 'Create an account'}
          </button>
        </p>}
      </div>
    </main>
  )
}
