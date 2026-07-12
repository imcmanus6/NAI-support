/**
 * Customer chat client. In DEMO mode (no customer token configured) it returns
 * canned responses so the UI can be visualized without the backend. When a token
 * is present it calls the real /api/chat + /api/chat/tickets/confirm endpoints.
 */
export interface ProposedTicket { title: string; description: string; spaceId: string | null }
export interface ChatResponse {
  conversation_id: string
  reply: string
  proposed_ticket: ProposedTicket | null
}

// The identity token can arrive three ways (checked in order):
//   1. window.__SUPPORT_TOKEN__  — set by the host page when the widget is embedded
//   2. ?token=…                  — handy for local testing
//   3. VITE_CUSTOMER_TOKEN       — build-time default
declare global {
  interface Window { __SUPPORT_TOKEN__?: string }
}
function resolveToken(): string | undefined {
  // Hash first: the host embeds us as `…#token=…`. The fragment is never sent in
  // HTTP requests, so the token doesn't land in server logs or the Referer header.
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') || undefined
  const fromUrl = new URLSearchParams(window.location.search).get('token') || undefined
  return window.__SUPPORT_TOKEN__ ?? fromHash ?? fromUrl ?? (import.meta.env.VITE_CUSTOMER_TOKEN as string | undefined)
}
const CUSTOMER_TOKEN = resolveToken()
export const DEMO = !CUSTOMER_TOKEN

// API base: empty in dev (Vite proxy forwards /api → the API). In production set
// VITE_API_URL to the deployed NAI API origin, e.g. https://api.nai.dev.
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
const url = (path: string) => `${API_BASE}${path}`

export interface Attachment { name: string; type: string; size: number }
export interface ClientContext {
  url?: string
  referrer?: string
  language?: string
  timezone?: string
  screen?: string
  userAgent?: string
  attachment?: Attachment
}

/** Auto-capture the session context the support team needs to action a ticket. */
export function clientContext(): ClientContext {
  return {
    url: window.location.href,
    referrer: document.referrer || undefined,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${window.screen.width}x${window.screen.height}`,
    userAgent: navigator.userAgent,
  }
}

/** Short browser label for display (server does the authoritative parse). */
export function shortBrowser(ua = navigator.userAgent): string {
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari/.test(ua)) return 'Safari'
  return 'Browser'
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(CUSTOMER_TOKEN ? { Authorization: `Bearer ${CUSTOMER_TOKEN}` } : {}) }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── Demo responder ────────────────────────────────────────────────────────────
function demoReply(message: string): ChatResponse {
  const m = message.toLowerCase()
  const convId = 'demo-conversation'
  if (/(refund|money back|cancel.*order)/.test(m)) {
    return {
      conversation_id: convId,
      reply: "I can help with that. Our policy allows refunds within 30 days of purchase. Since your order is outside that window, I'll raise this with a teammate who can review an exception.",
      proposed_ticket: {
        title: 'Refund exception request',
        description: 'Customer is requesting a refund outside the 30-day window. Order context gathered from account. Needs human review.',
        spaceId: null,
      },
    }
  }
  if (/(broken|bug|not working|error|crash)/.test(m)) {
    return {
      conversation_id: convId,
      reply: "Sorry you're hitting that. I've checked our known-issues and don't see a match, so I'll create a ticket for our engineers with the details you gave.",
      proposed_ticket: {
        title: 'Reported issue from customer',
        description: `Customer report: "${message}". No matching known issue found.`,
        spaceId: null,
      },
    }
  }
  if (/(reset|password|log ?in|sign ?in)/.test(m)) {
    return {
      conversation_id: convId,
      reply: 'To reset your password, open the login page and choose "Forgot password" — you\'ll get an email link within a few minutes. Want me to check whether your account is locked?',
      proposed_ticket: null,
    }
  }
  return {
    conversation_id: convId,
    reply: "Thanks for reaching out! I can answer questions about your account, orders, and how things work — or raise a ticket if you need a human. What can I help with?",
    proposed_ticket: null,
  }
}

export interface WidgetConfig { help_url: string | null }

export async function getConfig(): Promise<WidgetConfig> {
  // Demo points at Briefly's real Help Center so the link is visible without a backend.
  if (DEMO) { await delay(150); return { help_url: 'https://app.brief-ly.com/projects/930d5fc2-36aa-4328-bd3d-e752b51629b3' } }
  const res = await fetch(url('/api/config'), { headers: authHeaders() })
  if (!res.ok) return { help_url: null }
  return (await res.json() as { data: WidgetConfig }).data
}

export async function sendMessage(message: string, _conversationId?: string): Promise<ChatResponse> {
  if (DEMO) { await delay(600); return demoReply(message) }
  const res = await fetch(url('/api/chat'), {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ message, context: clientContext() }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json() as { data: ChatResponse }).data
}

/** Ask the host page (parent window) for its captured console/network/error buffers. */
export function requestHostDiagnostics(timeoutMs = 600): Promise<unknown | undefined> {
  if (window.self === window.top) return Promise.resolve(undefined) // not embedded
  return new Promise(resolve => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    let settled = false
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: string; data?: unknown }
      if (d?.type === 'support:diagnostics' && d.id === id) {
        settled = true; window.removeEventListener('message', onMsg); resolve(d.data)
      }
    }
    window.addEventListener('message', onMsg)
    window.parent.postMessage({ type: 'support:get-diagnostics', id }, '*')
    setTimeout(() => { if (!settled) { window.removeEventListener('message', onMsg); resolve(undefined) } }, timeoutMs)
  })
}

export interface RecordingPayload { events: unknown[]; meta?: Record<string, unknown> }

/** Upload an rrweb reproduction; returns the stored recording id (or null). */
export async function uploadRecording(payload: RecordingPayload): Promise<string | null> {
  if (DEMO) { await delay(300); return 'demo-recording' }
  const res = await fetch(url('/api/recordings'), {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(payload),
  })
  if (!res.ok) return null
  return (await res.json() as { data: { id: string } }).data.id
}

/** A self-serve fix the auto-diagnosis proposes before filing a ticket. */
export interface Deflection { summary: string; cause: string; steps: string[] }
export interface ConfirmResult { deflected?: boolean; diagnosis?: Deflection }

export async function confirmTicket(
  conversationId: string,
  ticket: ProposedTicket,
  attachment?: Attachment,
  recordingId?: string,
  force = false,   // the customer tried the suggested fix and still needs a human
): Promise<ConfirmResult> {
  if (DEMO) { await delay(500); return {} }
  const diagnostics = await requestHostDiagnostics()  // pull the host's console/network capture
  const res = await fetch(url('/api/chat/tickets/confirm'), {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      conversation_id: conversationId,
      title: ticket.title,
      description: ticket.description,
      context: { ...clientContext(), attachment },
      diagnostics,
      recording_id: recordingId,
      force,
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json() as { data: ConfirmResult }).data
}

/** Customer confirmed the self-serve steps fixed it — close the conversation, no ticket. */
export async function resolveConversation(conversationId: string): Promise<void> {
  if (DEMO) { await delay(200); return }
  const res = await fetch(url('/api/chat/tickets/resolve'), {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ conversation_id: conversationId }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

export interface Ticket {
  id: string
  title: string
  status: string
  url: string | null
  created_at: string
  updated_at: string | null
  reporter?: string | null   // present when viewing a shared org's tickets
}

const DEMO_TICKETS: Ticket[] = [
  { id: 't1', title: 'Refund exception request', status: 'in_progress', url: null, created_at: '2026-07-09T10:00:00Z', updated_at: '2026-07-10T09:00:00Z' },
  { id: 't2', title: 'App crash on upload', status: 'complete', url: null, created_at: '2026-07-05T14:00:00Z', updated_at: '2026-07-06T11:00:00Z' },
]

export async function listTickets(): Promise<Ticket[]> {
  if (DEMO) { await delay(300); return DEMO_TICKETS }
  const res = await fetch(url('/api/tickets'), { headers: authHeaders() })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json() as { data: Ticket[] }).data
}

export interface TicketComment {
  id: string
  from: 'customer' | 'support'
  author: string
  body: string
  created_at: string
}

const DEMO_COMMENTS: Record<string, TicketComment[]> = {
  t1: [
    { id: 'c1', from: 'support', author: 'Chris (Support)', body: "Thanks for reaching out — I've passed this to our billing team for review.", created_at: '2026-07-09T11:00:00Z' },
    { id: 'c2', from: 'customer', author: 'You', body: 'Great, thank you!', created_at: '2026-07-09T11:05:00Z' },
    { id: 'c3', from: 'support', author: 'Chris (Support)', body: "Good news — the refund exception is approved. It'll process in 3–5 days.", created_at: '2026-07-10T09:00:00Z' },
  ],
  t2: [
    { id: 'c4', from: 'support', author: 'Support', body: 'Fixed in the latest release — please update the app and let us know if it persists.', created_at: '2026-07-06T11:00:00Z' },
  ],
}

export async function getTicketComments(ticketId: string): Promise<TicketComment[]> {
  if (DEMO) { await delay(300); return DEMO_COMMENTS[ticketId] ?? [] }
  const res = await fetch(url(`/api/tickets/${ticketId}/comments`), { headers: authHeaders() })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json() as { data: TicketComment[] }).data
}

export async function postTicketComment(ticketId: string, body: string): Promise<void> {
  if (DEMO) { await delay(300); return }
  const res = await fetch(url(`/api/tickets/${ticketId}/comments`), {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ body }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}
