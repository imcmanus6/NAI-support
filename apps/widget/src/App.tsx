import { useEffect, useRef, useState } from 'react'
import {
  sendMessage, confirmTicket, listTickets, getTicketComments, postTicketComment, getConfig,
  uploadRecording, clientContext, shortBrowser, DEMO,
  type ProposedTicket, type Attachment, type Ticket, type TicketComment, type RecordingPayload,
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
  ticketState?: 'pending' | 'confirmed'
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
    try {
      const res = await sendMessage(trimmed, conversationId)
      setConversationId(res.conversation_id)
      setItems(prev => [...prev, {
        id: `a-${prev.length}`,
        role: 'agent',
        content: res.reply,
        ticket: res.proposed_ticket,
        ticketState: res.proposed_ticket ? 'pending' : undefined,
      }])
    } catch (e) {
      setItems(prev => [...prev, { id: `e-${prev.length}`, role: 'agent', content: `Something went wrong: ${String(e)}` }])
    } finally {
      setBusy(false)
    }
  }

  async function onConfirmTicket(itemId: string, ticket: ProposedTicket) {
    if (!conversationId) return
    await confirmTicket(conversationId, ticket, attachments[itemId], recordings[itemId])
    setItems(prev => prev.map(it => it.id === itemId ? { ...it, ticketState: 'confirmed' } : it))
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
                  <div className="ticket-card">
                    <div className="ticket-label">Ticket to raise</div>
                    <div className="ticket-title">{item.ticket.title}</div>
                    <div className="ticket-desc">{item.ticket.description}</div>

                    <div className="ticket-context">
                      <span className="ctx-key">Automatically included</span>
                      <span>{contextSummary()} · your IP &amp; location</span>
                      {attachments[item.id] && <span className="attach-chip">📎 {attachments[item.id].name}</span>}
                    </div>

                    {item.ticketState === 'confirmed'
                      ? <div className="ticket-confirmed">✓ Ticket raised — a teammate will follow up.</div>
                      : (
                        <div className="ticket-actions">
                          <button className="btn primary" onClick={() => void onConfirmTicket(item.id, item.ticket!)}>Raise ticket</button>
                          {embedded && (
                            <button className="btn" onClick={() => startRecording(item.id)}>
                              {recordings[item.id] ? '🎥 Recording attached' : '📹 Record & reproduce'}
                            </button>
                          )}
                          <button className="btn" onClick={() => pickAttachment(item.id)}>
                            {attachments[item.id] ? 'Change screenshot' : 'Add screenshot'}
                          </button>
                          <button className="btn" onClick={() => onDismissTicket(item.id)}>Not now</button>
                        </div>
                      )}
                  </div>
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="row agent">
              <div className="bubble agent"><div className="typing"><span /><span /><span /></div></div>
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
