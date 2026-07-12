import { useEffect, useRef, useState } from 'react'
import {
  sendMessage, confirmTicket, resolveConversation, listTickets, getTicketComments, postTicketComment, getConfig,
  uploadRecording, clientContext, shortBrowser, DEMO,
  type ProposedTicket, type Attachment, type Ticket, type TicketComment, type RecordingPayload, type Deflection,
} from './lib/api'

function statusColor(status: string): string {
  const s = status.toLowerCase()
  if (['complete', 'done', 'resolved', 'closed'].includes(s)) return '#16a34a'
  if (['in_progress', 'waiting', 'blocked'].includes(s)) return '#d97706'
  if (s === 'failed') return '#ef4444'
  return '#6366f1'
}
function prettyStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function contextSummary(): string {
  const ctx = clientContext()
  let host = ctx.url
  try { host = new URL(ctx.url!).host } catch { /* keep raw */ }
  return [host, shortBrowser(), ctx.language, ctx.screen].filter(Boolean).join(' · ')
}

interface ChatItem {
  id: string
  role: 'customer' | 'agent'
  content: string
  ticket?: ProposedTicket | null
  ticketState?: 'pending' | 'confirmed' | 'resolved'
  deflection?: Deflection   // self-serve fix proposed before filing
}

const GREETING: ChatItem = {
  id: 'greeting',
  role: 'agent',
  content: 'Hi! 👋 I\'m here to help. Ask about your account or orders, or tell me what\'s gone wrong and I can raise it with the team.',
}

// Prompt suggestions are intentionally omitted until they can be contextual — driven
// by the page the user is on and what we know about them, not a canned generic list.

export function App() {
  const [items, setItems] = useState<ChatItem[]>([GREETING])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)   // live "Checking…" progress
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [attachments, setAttachments] = useState<Record<string, Attachment>>({})
  const [recordings, setRecordings] = useState<Record<string, string>>({})  // itemId → recordingId
  const recordingFor = useRef<string | null>(null)
  const [view, setView] = useState<'chat' | 'tickets'>('chat')
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [ticketsLoading, setTicketsLoading] = useState(false)
  const [openTicket, setOpenTicket] = useState<Ticket | null>(null)
  const [comments, setComments] = useState<TicketComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [helpUrl, setHelpUrl] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { getConfig().then(c => setHelpUrl(c.help_url)).catch(() => {}) }, [])

  // Receive a finished recording from the host loader, upload it, attach to the ticket.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; data?: RecordingPayload }
      if (d?.type === 'nai:record-events' && recordingFor.current) {
        const itemId = recordingFor.current
        recordingFor.current = null
        uploadRecording(d.data!).then(id => { if (id) setRecordings(prev => ({ ...prev, [itemId]: id })) }).catch(() => {})
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  function startRecording(itemId: string) {
    recordingFor.current = itemId
    window.parent.postMessage({ type: 'nai:record-start' }, '*')  // loader hides us + starts rrweb
  }
  const fileFor = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  function openTickets() {
    setView('tickets'); setOpenTicket(null); setTicketsLoading(true)
    listTickets().then(setTickets).catch(() => setTickets([])).finally(() => setTicketsLoading(false))
  }

  function openTicketDetail(t: Ticket) {
    setOpenTicket(t); setComments([]); setCommentsLoading(true); setReply('')
    getTicketComments(t.id).then(setComments).catch(() => setComments([])).finally(() => setCommentsLoading(false))
  }

  async function sendReply() {
    if (!openTicket || !reply.trim() || replySending) return
    const text = reply.trim()
    setReply(''); setReplySending(true)
    setComments(prev => [...prev, { id: `local-${prev.length}`, from: 'customer', author: 'You', body: text, created_at: new Date().toISOString() }])
    try { await postTicketComment(openTicket.id, text) } catch { /* keep optimistic entry */ }
    finally { setReplySending(false) }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [items, busy])

  async function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setInput('')
    setItems(prev => [...prev, { id: `c-${prev.length}`, role: 'customer', content: trimmed }])
    setBusy(true)
    setStatus('Looking into it…')
    try {
      const res = await sendMessage(trimmed, conversationId, setStatus)
      setConversationId(res.conversation_id)
      setItems(prev => [...prev, {
        id: `a-${prev.length}`,
        role: 'agent',
        content: res.reply,
        ticket: res.proposed_ticket,
        ticketState: res.proposed_ticket ? 'pending' : undefined,
      }])
    } catch (e) {
      console.error('[support] send failed:', e)
      // A TypeError from fetch means the network/server was unreachable — say so plainly
      // and keep it retryable, rather than dumping "TypeError: Failed to fetch" at the customer.
      const offline = e instanceof TypeError
      setItems(prev => [...prev, { id: `e-${prev.length}`, role: 'agent', content: offline
        ? "I couldn't reach support just now — please check your connection and send that again."
        : "Something went wrong on our end. Please try again in a moment." }])
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  async function onConfirmTicket(itemId: string, ticket: ProposedTicket, force = false) {
    if (!conversationId) return
    const res = await confirmTicket(conversationId, ticket, attachments[itemId], recordings[itemId], force)
    if (res.deflected && res.diagnosis) {
      // Auto-diagnosis thinks the customer can fix this — show the steps, hold the ticket.
      setItems(prev => prev.map(it => it.id === itemId ? { ...it, deflection: res.diagnosis } : it))
      return
    }
    setItems(prev => prev.map(it => it.id === itemId ? { ...it, ticketState: 'confirmed' } : it))
  }

  async function onResolved(itemId: string) {
    if (!conversationId) return
    setItems(prev => prev.map(it => it.id === itemId ? { ...it, ticketState: 'resolved' } : it))
    try { await resolveConversation(conversationId) } catch { /* best-effort close */ }
  }

  function pickAttachment(itemId: string) {
    fileFor.current = itemId
    fileInput.current?.click()
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const itemId = fileFor.current
    if (file && itemId) {
      setAttachments(prev => ({ ...prev, [itemId]: { name: file.name, type: file.type || 'file', size: file.size } }))
    }
    e.target.value = ''
    fileFor.current = null
  }

  function onDismissTicket(itemId: string) {
    setItems(prev => prev.map(it => it.id === itemId ? { ...it, ticket: null, ticketState: undefined } : it))
  }

  // When embedded in a host page (iframe), fill the frame instead of centering a card.
  const embedded = window.self !== window.top

  return (
    <div className={`launcher-wrap${embedded ? ' embedded' : ''}`}>
      <div className="widget">
        <div className="widget-header">
          <div className="avatar">AI</div>
          <div>
            <div className="header-title">Support</div>
            <div className="header-sub"><span className="dot" /> Typically replies in seconds</div>
          </div>
          {DEMO && <span className="demo-badge">Demo</span>}
        </div>
        <div className="tabs">
          <button className={`tab${view === 'chat' ? ' active' : ''}`} onClick={() => setView('chat')}>Chat</button>
          <button className={`tab${view === 'tickets' ? ' active' : ''}`} onClick={openTickets}>My tickets</button>
        </div>

        {view === 'tickets' ? (
          openTicket ? (
            <div className="ticket-detail">
              <button className="back-btn" onClick={() => setOpenTicket(null)}>← All tickets</button>
              <div className="detail-head">
                <span className="ticket-row-title">{openTicket.title}</span>
                <span className="status-badge" style={{ color: statusColor(openTicket.status), borderColor: statusColor(openTicket.status) + '55' }}>
                  {prettyStatus(openTicket.status)}
                </span>
              </div>
              <div className="messages">
                {commentsLoading && <p className="tickets-empty">Loading…</p>}
                {!commentsLoading && comments.length === 0 && <p className="tickets-empty">No replies yet. Send one below.</p>}
                {comments.map(c => (
                  <div key={c.id} className={`row ${c.from === 'customer' ? 'customer' : 'agent'}`}>
                    <div className={`bubble ${c.from === 'customer' ? 'customer' : 'agent'}`}>
                      <div className="comment-author">{c.author}</div>
                      {c.body}
                    </div>
                  </div>
                ))}
              </div>
              <div className="composer">
                <textarea rows={1} placeholder="Write a reply…" value={reply}
                  onChange={e => setReply(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply() } }} />
                <button className="send" disabled={replySending || !reply.trim()} onClick={() => void sendReply()} aria-label="Send reply">↑</button>
              </div>
            </div>
          ) : (
            <div className="tickets">
              {ticketsLoading && <p className="tickets-empty">Loading…</p>}
              {!ticketsLoading && tickets.length === 0 && (
                <p className="tickets-empty">No tickets yet. Raise one from a chat and it'll show here.</p>
              )}
              {tickets.map(t => (
                <button key={t.id} className="ticket-row" onClick={() => openTicketDetail(t)}>
                  <div className="ticket-row-main">
                    <span className="ticket-row-title">{t.title}</span>
                    <span className="ticket-row-date">
                      {t.reporter ? `${t.reporter} · ` : ''}
                      {t.updated_at ? `Updated ${new Date(t.updated_at).toLocaleDateString()}` : new Date(t.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <span className="status-badge" style={{ color: statusColor(t.status), borderColor: statusColor(t.status) + '55' }}>
                    {prettyStatus(t.status)}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : (
        <>
        <div className="messages" ref={scrollRef}>
          {items.map(item => (
            <div key={item.id}>
              <div className={`row ${item.role}`}>
                <div className={`bubble ${item.role}`}>{item.content}</div>
              </div>
              {item.ticket && (
                <div style={{ marginTop: 10 }}>
                  {item.ticketState === 'confirmed' ? (
                    <div className="ticket-card">
                      <div className="ticket-confirmed">✓ Ticket raised — a teammate will follow up.</div>
                    </div>
                  ) : item.ticketState === 'resolved' ? (
                    <div className="ticket-card">
                      <div className="ticket-confirmed">✓ Glad that sorted it! I've closed this out — start a new chat anytime.</div>
                    </div>
                  ) : item.deflection ? (
                    // Auto-diagnosis found a fix the customer can apply — offer it before filing.
                    <div className="ticket-card deflect">
                      <div className="ticket-label">💡 Try this first</div>
                      <div className="ticket-desc">{item.deflection.summary}</div>
                      <ol className="deflect-steps">
                        {item.deflection.steps.map((s, i) => <li key={i}>{s}</li>)}
                      </ol>
                      <div className="ticket-actions">
                        <button className="btn primary" onClick={() => void onResolved(item.id)}>✓ That fixed it</button>
                        <button className="btn" onClick={() => void onConfirmTicket(item.id, item.ticket!, true)}>Still need help</button>
                      </div>
                    </div>
                  ) : (
                    <div className="ticket-card">
                      <div className="ticket-label">Ticket to raise</div>
                      <div className="ticket-title">{item.ticket.title}</div>
                      <div className="ticket-desc">{item.ticket.description}</div>

                      <div className="ticket-context">
                        <span className="ctx-key">Automatically included</span>
                        <span>{contextSummary()} · your IP &amp; location</span>
                        {attachments[item.id] && <span className="attach-chip">📎 {attachments[item.id].name}</span>}
                        {recordings[item.id] && <span className="attach-chip">🎥 Reproduction attached</span>}
                      </div>

                      {!recordings[item.id] && (
                        <div className="repro-nudge">
                          <strong>Help us fix this faster.</strong> A {embedded ? '10-second screen recording' : 'screenshot'} of
                          the problem is the single most useful thing for our engineers. Can’t make it happen again?
                          Clear your browser cache and hard-reload, then try once more.
                        </div>
                      )}

                      <div className="ticket-actions">
                        {embedded && (
                          <button className={`btn${recordings[item.id] ? '' : ' accent'}`} onClick={() => startRecording(item.id)}>
                            {recordings[item.id] ? '🎥 Recording attached' : '📹 Record a reproduction'}
                          </button>
                        )}
                        <button className={`btn${!embedded && !attachments[item.id] ? ' accent' : ''}`} onClick={() => pickAttachment(item.id)}>
                          {attachments[item.id] ? 'Change screenshot' : '📷 Add a screenshot'}
                        </button>
                        <button className="btn primary" onClick={() => void onConfirmTicket(item.id, item.ticket!)}>Raise ticket</button>
                        <button className="btn" onClick={() => onDismissTicket(item.id)}>Not now</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="row agent">
              <div className="bubble agent">
                {status
                  ? <div className="status-step"><span className="status-spinner" />{status}</div>
                  : <div className="typing"><span /><span /><span /></div>}
              </div>
            </div>
          )}
        </div>

        {items.length <= 1 && helpUrl && (
          <div className="suggestions">
            <a className="chip help-chip" href={helpUrl} target="_blank" rel="noopener noreferrer">📚 Browse the Help Center →</a>
          </div>
        )}

        <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFileChosen} />

        <div className="composer">
          <textarea
            rows={1}
            placeholder="Type a message…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(input) } }}
          />
          <button className="send" disabled={busy || !input.trim()} onClick={() => void submit(input)} aria-label="Send">↑</button>
        </div>
        </>
        )}
      </div>
    </div>
  )
}
