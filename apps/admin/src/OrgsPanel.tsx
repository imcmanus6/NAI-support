import { useEffect, useState } from 'react'
import {
  listOrgs, createOrg, updateOrg, deleteOrg,
  listOrgAdmins, addOrgAdmin, removeOrgAdmin,
  type Organization, type OrgAdmin,
} from './lib/api'

const input: React.CSSProperties = { padding: '6px 8px', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, boxSizing: 'border-box' }

export function OrgsPanel({ clientId }: { clientId: string }) {
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [domain, setDomain] = useState('')
  const [name, setName] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [admins, setAdmins] = useState<OrgAdmin[]>([])
  const [adminEmail, setAdminEmail] = useState('')
  const [err, setErr] = useState('')

  const load = () => { listOrgs(clientId).then(setOrgs).catch(e => setErr(String(e))) }
  useEffect(load, [clientId])

  async function add() {
    if (!domain.trim() || !name.trim()) return
    try { await createOrg(clientId, { domain: domain.trim(), name: name.trim(), share_tickets: true }); setDomain(''); setName(''); setErr(''); load() }
    catch (e) { setErr(String(e)) }
  }
  async function toggleShare(o: Organization) {
    await updateOrg(o.id, { share_tickets: !o.share_tickets })
    setOrgs(prev => prev.map(x => x.id === o.id ? { ...x, share_tickets: !o.share_tickets } : x))
  }
  async function remove(o: Organization) {
    if (!confirm(`Delete organization ${o.domain}?`)) return
    await deleteOrg(o.id); if (expanded === o.id) setExpanded(null); load()
  }
  function expand(o: Organization) {
    if (expanded === o.id) { setExpanded(null); return }
    setExpanded(o.id); setAdmins([]); setAdminEmail('')
    listOrgAdmins(o.id).then(setAdmins).catch(() => setAdmins([]))
  }
  async function addAdmin(orgId: string) {
    if (!adminEmail.trim()) return
    try { const a = await addOrgAdmin(orgId, adminEmail.trim()); setAdmins(prev => [...prev, a]); setAdminEmail('') }
    catch (e) { setErr(String(e)) }
  }
  async function removeAdmin(orgId: string, a: OrgAdmin) {
    await removeOrgAdmin(orgId, a.id); setAdmins(prev => prev.filter(x => x.id !== a.id))
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#888', margin: '0 0 8px' }}>
        Group customers by email domain. Members of a shared org see each other's tickets;
        org admins always do.
      </p>

      {orgs.map(o => (
        <div key={o.id} style={{ border: '1px solid #e5e5e5', borderRadius: 8, marginBottom: 6, padding: '8px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{o.domain}</span>
            <span style={{ fontSize: 12, color: '#888' }}>{o.name}</span>
            <label style={{ marginLeft: 'auto', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={o.share_tickets} onChange={() => void toggleShare(o)} /> share tickets
            </label>
            <button onClick={() => expand(o)} style={{ fontSize: 12 }}>{expanded === o.id ? 'Hide admins' : 'Admins'}</button>
            <button onClick={() => void remove(o)} style={{ fontSize: 12, color: '#c00' }}>Delete</button>
          </div>
          {expanded === o.id && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #eee' }}>
              {admins.length === 0 && <p style={{ fontSize: 12, color: '#999', margin: '0 0 6px' }}>No org admins yet.</p>}
              {admins.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
                  <span>{a.email}</span>
                  <button onClick={() => void removeAdmin(o.id, a)} style={{ fontSize: 11, color: '#c00' }}>remove</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input style={{ ...input, flex: 1 }} placeholder="admin@domain.com" value={adminEmail} onChange={e => setAdminEmail(e.target.value)} />
                <button onClick={() => void addAdmin(o.id)} style={{ fontSize: 12 }}>Add admin</button>
              </div>
            </div>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input style={{ ...input, flex: 1 }} placeholder="domain.com" value={domain} onChange={e => setDomain(e.target.value)} />
        <input style={{ ...input, flex: 1 }} placeholder="Organization name" value={name} onChange={e => setName(e.target.value)} />
        <button onClick={() => void add()} style={{ fontSize: 13 }}>Add org</button>
      </div>
      {err && <p style={{ fontSize: 12, color: '#c00', marginTop: 6 }}>{err}</p>}
    </div>
  )
}
