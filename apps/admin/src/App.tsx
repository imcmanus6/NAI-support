import { useState } from 'react'
import { ClientsPage } from './pages/ClientsPage'
import { getAdminToken, setAdminToken, clearAdminToken, listClients } from './lib/api'

export function App() {
  const [authed, setAuthed] = useState(!!getAdminToken())
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function login() {
    if (!token.trim()) return
    setBusy(true); setError('')
    setAdminToken(token.trim())
    try {
      await listClients()          // verifies the token against the API
      setAuthed(true)
    } catch (e) {
      clearAdminToken()
      setError(String(e).includes('UNAUTHORIZED') ? 'Invalid admin token' : String(e))
    } finally { setBusy(false) }
  }

  function signOut() {
    clearAdminToken(); setAuthed(false); setToken('')
  }

  const wrap: React.CSSProperties = { maxWidth: 860, margin: '0 auto', padding: '2rem 1.25rem', fontFamily: 'system-ui, sans-serif' }

  if (!authed) {
    return (
      <div style={{ ...wrap, maxWidth: 360, marginTop: '12vh' }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>NAI · Support Console</h1>
        <p style={{ color: '#666', fontSize: 13, marginTop: 4 }}>Enter the admin token to continue.</p>
        <input
          type="password" value={token} autoFocus
          onChange={e => setToken(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void login() }}
          placeholder="Admin token"
          style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1px solid #ddd', borderRadius: 8, marginTop: 14, boxSizing: 'border-box' }}
        />
        {error && <p style={{ color: '#c00', fontSize: 12, marginTop: 8 }}>{error}</p>}
        <button onClick={() => void login()} disabled={busy}
          style={{ marginTop: 12, padding: '8px 16px', fontSize: 14 }}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </div>
    )
  }

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>NAI · Support Console</h1>
          <p style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
            Configure each host: identity, credentials, spaces, and the live-DB connection.
          </p>
        </div>
        <button onClick={signOut} style={{ fontSize: 12, color: '#666' }}>Sign out</button>
      </div>
      <ClientsPage />
    </div>
  )
}
