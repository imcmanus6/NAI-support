export type SpaceRole = 'help' | 'internal' | 'tickets'
export type TicketDestination = 'briefly' | 'jira'

export interface Client {
  id: string
  name: string
  client_key: string | null
  briefly_hub_id: string | null
  briefly_api_url: string | null
  ticket_destination: TicketDestination
  has_token_secret: boolean
  has_briefly_api_key: boolean
  created_at: string
}

export interface BrieflySpace {
  id: string; name: string; description: string | null; space_type: string
}
export interface ClientSpace {
  id: string; briefly_space_id: string; role: SpaceRole; label: string | null
}

const TOKEN_KEY = 'support_admin_token'
export const getAdminToken = () => localStorage.getItem(TOKEN_KEY) ?? ''
export const setAdminToken = (t: string) => localStorage.setItem(TOKEN_KEY, t)
export const clearAdminToken = () => localStorage.removeItem(TOKEN_KEY)

// API base: empty in dev (Vite proxy forwards /admin → the API). In production set
// VITE_API_URL to the deployed NAI API origin, e.g. https://api.nai.dev.
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? ''

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAdminToken()}`,
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 401) throw new Error('UNAUTHORIZED')
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ── Clients ───────────────────────────────────────────────────────────────────
export const listClients = () => api<{ data: Client[] }>('/admin/clients').then(r => r.data)
export const getClient = (id: string) => api<{ data: Client }>(`/admin/clients/${id}`).then(r => r.data)
export const createClient = (name: string) =>
  api<{ data: Client }>('/admin/clients', { method: 'POST', body: JSON.stringify({ name }) }).then(r => r.data)

export interface ClientPatch {
  name?: string
  client_key?: string
  token_secret?: string
  briefly_api_url?: string
  briefly_api_key?: string
  ticket_destination?: TicketDestination
}
export const updateClient = (id: string, patch: ClientPatch) =>
  api<{ data: Client }>(`/admin/clients/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(r => r.data)

// ── Spaces ────────────────────────────────────────────────────────────────────
export const listBrieflySpaces = (clientId: string) =>
  api<{ data: BrieflySpace[] }>(`/admin/clients/${clientId}/briefly-spaces`).then(r => r.data)
export const getClientSpaces = (id: string) =>
  api<{ data: ClientSpace[] }>(`/admin/clients/${id}/spaces`).then(r => r.data)
export const setClientSpaces = (
  id: string,
  spaces: { briefly_space_id: string; role: SpaceRole; label?: string }[],
) => api<{ data: ClientSpace[] }>(`/admin/clients/${id}/spaces`, {
  method: 'PUT', body: JSON.stringify({ spaces }),
}).then(r => r.data)

// ── Organizations ─────────────────────────────────────────────────────────────
export interface Organization { id: string; domain: string; name: string; share_tickets: boolean }
export interface OrgAdmin { id: string; email: string }

export const listOrgs = (clientId: string) =>
  api<{ data: Organization[] }>(`/admin/clients/${clientId}/orgs`).then(r => r.data)
export const createOrg = (clientId: string, o: { domain: string; name: string; share_tickets: boolean }) =>
  api<{ data: Organization }>(`/admin/clients/${clientId}/orgs`, { method: 'POST', body: JSON.stringify(o) }).then(r => r.data)
export const updateOrg = (orgId: string, patch: { name?: string; share_tickets?: boolean }) =>
  api<{ data: Organization }>(`/admin/orgs/${orgId}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(r => r.data)
export const deleteOrg = (orgId: string) => api<void>(`/admin/orgs/${orgId}`, { method: 'DELETE' })
export const listOrgAdmins = (orgId: string) =>
  api<{ data: OrgAdmin[] }>(`/admin/orgs/${orgId}/admins`).then(r => r.data)
export const addOrgAdmin = (orgId: string, email: string) =>
  api<{ data: OrgAdmin }>(`/admin/orgs/${orgId}/admins`, { method: 'POST', body: JSON.stringify({ email }) }).then(r => r.data)
export const removeOrgAdmin = (orgId: string, adminId: string) =>
  api<void>(`/admin/orgs/${orgId}/admins/${adminId}`, { method: 'DELETE' })

// ── Software-DB connection ────────────────────────────────────────────────────
export const getSoftwareDb = (id: string) =>
  api<{ data: { config: Record<string, unknown>; configured: boolean } | null }>(`/admin/clients/${id}/software-db`).then(r => r.data)
export const setSoftwareDb = (id: string, config: unknown) =>
  api<{ data: { ok: true } }>(`/admin/clients/${id}/software-db`, { method: 'PUT', body: JSON.stringify(config) })
