import { useEffect, useState } from 'react'
import {
  listClients, createClient, getClient, updateClient,
  listBrieflySpaces, getClientSpaces, setClientSpaces,
  getSoftwareDb, setSoftwareDb,
  type Client, type BrieflySpace, type SpaceRole, type TicketDestination,
} from '../lib/api'
import { OrgsPanel } from '../OrgsPanel'

type Role = SpaceRole | null
const NEXT_ROLE: Record<string, Role> = { none: 'help', help: 'internal', internal: 'tickets', tickets: null }
const ROLE_BG: Record<SpaceRole, string> = { help: '#dbeafe', internal: '#fef3c7', tickets: '#dcfce7' }
const ROLE_LABEL: Record<SpaceRole, string> = { help: 'Public help', internal: 'Internal', tickets: 'Tickets' }

const SOFTWARE_DB_TEMPLATE = `{
  "url": "postgres://readonly:PASSWORD@replica-host:5432/app",
  "account": {
    "relation": "support_account_v",
    "customerKey": "user_id",
    "columns": { "plan": "plan", "status": "status" }
  },
  "access": {
    "relation": "user_grants_v",
    "customerKey": "user_id",
    "columns": { "resource": "resource", "level": "role" }
  }
}`

const input: React.CSSProperties = { width: '100%', padding: '6px 8px', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, boxSizing: 'border-box' }
const label: React.CSSProperties = { fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '.04em', display: 'block', marginBottom: 3, marginTop: 10 }
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, margin: '18px 0 4px' }

export function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [selected, setSelected] = useState<Client | null>(null)
  const [newName, setNewName] = useState('')
  const [msg, setMsg] = useState('')

  // Settings form
  const [name, setName] = useState('')
  const [clientKey, setClientKey] = useState('')
  const [ticketDest, setTicketDest] = useState<TicketDestination>('briefly')
  const [brieflyUrl, setBrieflyUrl] = useState('')
  const [brieflyKey, setBrieflyKey] = useState('')
  const [tokenSecret, setTokenSecret] = useState('')

  // Spaces
  const [spaces, setSpaces] = useState<BrieflySpace[]>([])
  const [spacesError, setSpacesError] = useState('')
  const [choices, setChoices] = useState<Record<string, Role>>({})

  // Software DB
  const [dbConfig, setDbConfig] = useState('')

  useEffect(() => { listClients().then(setClients).catch(e => setMsg(String(e))) }, [])

  async function selectClient(c: Client) {
    setSelected(c); setMsg(''); setSpacesError(''); setBrieflyKey(''); setTokenSecret('')
    const fresh = await getClient(c.id).catch(() => c)
    setName(fresh.name); setClientKey(fresh.client_key ?? ''); setTicketDest(fresh.ticket_destination)
    setBrieflyUrl(fresh.briefly_api_url ?? '')

    getClientSpaces(c.id).then(rows => {
      const next: Record<string, Role> = {}
      for (const r of rows) next[r.briefly_space_id] = r.role
      setChoices(next)
    }).catch(() => setChoices({}))

    listBrieflySpaces(c.id).then(setSpaces).catch(e => { setSpaces([]); setSpacesError(String(e)) })
    getSoftwareDb(c.id).then(r => setDbConfig(r ? JSON.stringify(r.config, null, 2) : SOFTWARE_DB_TEMPLATE)).catch(() => setDbConfig(SOFTWARE_DB_TEMPLATE))
  }

  async function addClient() {
    if (!newName.trim()) return
    try {
      const c = await createClient(newName.trim())
      setNewName(''); setClients(prev => [...prev, c]); void selectClient(c)
    } catch (e) { setMsg(String(e)) }
  }

  async function saveSettings() {
    if (!selected) return
    try {
      const updated = await updateClient(selected.id, {
        name, client_key: clientKey, ticket_destination: ticketDest,
        briefly_api_url: brieflyUrl,
        ...(brieflyKey ? { briefly_api_key: brieflyKey } : {}),
        ...(tokenSecret ? { token_secret: tokenSecret } : {}),
      })
      setBrieflyKey(''); setTokenSecret('')
      setClients(prev => prev.map(c => c.id === updated.id ? updated : c))
      setSelected(updated)
      setMsg('Settings saved ✓')
      // Credentials may have changed — refresh the space list.
      listBrieflySpaces(selected.id).then(setSpaces).then(() => setSpacesError('')).catch(e => { setSpaces([]); setSpacesError(String(e)) })
    } catch (e) { setMsg(String(e)) }
  }

  function cycle(spaceId: string) {
    setChoices(prev => ({ ...prev, [spaceId]: NEXT_ROLE[prev[spaceId] ?? 'none'] }))
  }
  async function saveSpaces() {
    if (!selected) return
    const payload = Object.entries(choices).filter(([, r]) => r !== null).map(([briefly_space_id, r]) => ({
      briefly_space_id, role: r as SpaceRole, label: spaces.find(s => s.id === briefly_space_id)?.name,
    }))
    try { await setClientSpaces(selected.id, payload); setMsg('Space mapping saved ✓') } catch (e) { setMsg(String(e)) }
  }

  async function saveDb() {
    if (!selected) return
    let parsed: unknown
    try { parsed = JSON.parse(dbConfig) } catch { setMsg('Software-DB config is not valid JSON'); return }
    try { await setSoftwareDb(selected.id, parsed); setMsg('Software-DB connection saved ✓') } catch (e) { setMsg(String(e)) }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 24, marginTop: 24 }}>
      {/* Clients list */}
      <div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New host" style={{ ...input, flex: 1 }} />
          <button onClick={() => void addClient()} style={{ fontSize: 13 }}>Add</button>
        </div>
        {clients.map(c => (
          <button key={c.id} onClick={() => void selectClient(c)}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', fontSize: 13,
              border: '1px solid ' + (selected?.id === c.id ? '#4f46e5' : '#eee'),
              borderRadius: 6, marginBottom: 4, background: selected?.id === c.id ? '#eef2ff' : '#fff' }}>
            {c.name}{c.client_key ? <span style={{ color: '#999', fontSize: 11 }}> · {c.client_key}</span> : null}
          </button>
        ))}
      </div>

      {/* Editor */}
      <div style={{ maxWidth: 560 }}>
        {!selected && <p style={{ color: '#888', fontSize: 13 }}>Select or add a host to configure it.</p>}
        {selected && (
          <>
            <div style={sectionTitle}>Identity & credentials</div>
            <label style={label}>Name</label>
            <input style={input} value={name} onChange={e => setName(e.target.value)} />
            <label style={label}>Client key <span style={{ textTransform: 'none' }}>(goes in the host's token)</span></label>
            <input style={input} value={clientKey} onChange={e => setClientKey(e.target.value)} placeholder="e.g. briefly" />
            <label style={label}>Ticket destination</label>
            <select style={input} value={ticketDest} onChange={e => setTicketDest(e.target.value as TicketDestination)}>
              <option value="briefly">Briefly</option>
              <option value="jira">Jira (not wired yet)</option>
            </select>
            <label style={label}>Briefly API URL <span style={{ textTransform: 'none' }}>(blank = env default)</span></label>
            <input style={input} value={brieflyUrl} onChange={e => setBrieflyUrl(e.target.value)} placeholder="http://localhost:3001" />
            <label style={label}>Briefly API key</label>
            <input style={input} type="password" value={brieflyKey} onChange={e => setBrieflyKey(e.target.value)}
              placeholder={selected.has_briefly_api_key ? 'set — leave blank to keep' : 'not set (uses env)'} />
            <label style={label}>Token secret <span style={{ textTransform: 'none' }}>(verifies this host's identity tokens)</span></label>
            <input style={input} type="password" value={tokenSecret} onChange={e => setTokenSecret(e.target.value)}
              placeholder={selected.has_token_secret ? 'set — leave blank to keep' : 'not set (uses env)'} />
            <div style={{ marginTop: 10 }}>
              <button onClick={() => void saveSettings()} style={{ fontSize: 13, padding: '6px 14px' }}>Save settings</button>
            </div>

            {/* Space mapping */}
            <div style={sectionTitle}>Knowledge & ticket spaces</div>
            <p style={{ fontSize: 12, color: '#888', margin: '0 0 8px' }}>
              Click to cycle: off → <b>Public help</b> → <b>Internal</b> → <b>Tickets</b>.
            </p>
            {spacesError && <p style={{ fontSize: 12, color: '#c00' }}>Couldn't list spaces — add a valid Briefly API key above, save, and it'll reload. ({spacesError})</p>}
            {spaces.map(s => {
              const role = choices[s.id] ?? null
              return (
                <button key={s.id} onClick={() => cycle(s.id)}
                  style={{ display: 'flex', justifyContent: 'space-between', width: '100%', textAlign: 'left',
                    padding: '8px 10px', fontSize: 13, border: '1px solid #e5e5e5', borderRadius: 6, marginBottom: 4,
                    background: role ? ROLE_BG[role] : '#fff' }}>
                  <span>{s.name}</span>
                  <span style={{ fontSize: 11, color: '#666', textTransform: 'uppercase' }}>{role ? ROLE_LABEL[role] : ''}</span>
                </button>
              )
            })}
            {spaces.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button onClick={() => void saveSpaces()} style={{ fontSize: 13, padding: '6px 14px' }}>Save space mapping</button>
              </div>
            )}

            {/* Organizations */}
            <div style={sectionTitle}>Organizations <span style={{ fontWeight: 400, color: '#888', fontSize: 12 }}>— group customers by domain</span></div>
            <OrgsPanel clientId={selected.id} />

            {/* Software DB */}
            <div style={sectionTitle}>Live database connection <span style={{ fontWeight: 400, color: '#888', fontSize: 12 }}>— read-only, unlocks user-specific answers</span></div>
            <p style={{ fontSize: 12, color: '#888', margin: '0 0 6px' }}>
              Point at a read replica. Map <code>account</code>, <code>orders</code>, and <code>access</code> (permissions),
              each keyed by the customer id. Leave blank for knowledge + tickets only.
            </p>
            <textarea value={dbConfig} onChange={e => setDbConfig(e.target.value)}
              spellCheck={false}
              style={{ ...input, height: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
            <div style={{ marginTop: 8 }}>
              <button onClick={() => void saveDb()} style={{ fontSize: 13, padding: '6px 14px' }}>Save DB connection</button>
            </div>

            {msg && <p style={{ fontSize: 12, color: msg.includes('✓') ? '#16a34a' : '#c00', marginTop: 12 }}>{msg}</p>}
          </>
        )}
      </div>
    </div>
  )
}
