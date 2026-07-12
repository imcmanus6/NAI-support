/**
 * Customer-facing chat route. Authenticated by the end-customer's identity token
 * (customerAuth.ts). Every request is scoped to the verified (clientId, customerId)
 * — the agent's tools inherit that scope and cannot widen it.
 */
import type { FastifyInstance } from 'fastify'
import { and, eq, asc, desc } from 'drizzle-orm'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { db } from '../db/client.js'
import { conversations, messages, clientSpaces, tickets, clients, recordings } from '../db/schema.js'
import { config } from '../lib/config.js'
import { resolveCustomer } from '../lib/customerAuth.js'
import { runAgentTurn, type AgentContext } from '../services/supportAgent.js'
import { getTicketSink, TicketSinkError } from '../services/ticketSink.js'
import { buildTicketContext, type ClientContext } from '../lib/requestContext.js'
import { searchSpaces } from '../services/knowledge.js'
import { brieflyClientFor } from '../lib/brieflyClient.js'
import { diagnose } from '../services/diagnose.js'
import { resolveTicketScope, emailDomain, type TicketScope } from '../services/ticketVisibility.js'

const ClientContextSchema = z.object({
  url: z.string().max(2000).optional(),
  referrer: z.string().max(2000).optional(),
  language: z.string().max(35).optional(),
  timezone: z.string().max(64).optional(),
  screen: z.string().max(20).optional(),
  userAgent: z.string().max(500).optional(),
  attachment: z.object({ name: z.string().max(255), type: z.string().max(120), size: z.number() }).optional(),
}).optional()

const ChatSchema = z.object({
  message: z.string().min(1).max(4000),
  context: ClientContextSchema,
})
const DiagnosticsSchema = z.object({
  console: z.array(z.object({ level: z.string(), message: z.string() })).max(50).optional(),
  network: z.array(z.object({ method: z.string(), url: z.string(), status: z.number(), ms: z.number() })).max(50).optional(),
  errors: z.array(z.object({ message: z.string() })).max(50).optional(),
}).optional()

const ConfirmTicketSchema = z.object({
  conversation_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).default(''),
  context: ClientContextSchema,   // e.g. an attachment added at confirm time
  diagnostics: DiagnosticsSchema, // host-page console/network/errors captured by the host
  recording_id: z.string().uuid().optional(), // an rrweb reproduction to attach
})

const RecordingSchema = z.object({
  events: z.array(z.any()).min(1).max(50_000),
  meta: z.record(z.any()).optional(),
})

const ReplySchema = z.object({ body: z.string().min(1).max(4000) })

// Customer replies are posted to Briefly prefixed with a marker carrying the
// author's email, so a shared org thread can attribute each customer comment
// (and pick out the viewer's own as "You").
const CUSTOMER_PREFIX_RE = /^\[Customer(?::([^\]]*))?\]\s?/
function customerPrefix(email?: string): string { return `[Customer:${email ?? 'customer'}] ` }

/** Load a ticket the customer is allowed to see: their own, or (org mode) their domain's. */
async function findVisibleTicket(ticketId: string, clientId: string, customerId: string, scope: TicketScope) {
  const [t] = await db.select({
    id: tickets.id, external_id: tickets.external_id,
    owner: conversations.external_customer_id, domain: conversations.customer_domain,
  }).from(tickets)
    .innerJoin(conversations, eq(tickets.conversation_id, conversations.id))
    .where(and(eq(tickets.id, ticketId), eq(conversations.client_id, clientId))).limit(1)
  if (!t) return null
  const visible = t.owner === customerId || (scope.mode === 'org' && !!scope.domain && t.domain === scope.domain)
  return visible ? t : null
}

export async function conversationsRoutes(fastify: FastifyInstance) {
  // Display config for the widget (help-center link, etc.) — scoped to the customer's client.
  fastify.get('/config', async (request, reply) => {
    const identity = await resolveCustomer(request)
    const [client] = await db.select({ help_url: clients.help_url }).from(clients).where(eq(clients.id, identity.clientId)).limit(1)
    if (!client) { reply.status(404); return { error: 'Client not found' } }
    return { data: { help_url: client.help_url ?? null } }
  })

  // Store an rrweb session recording (a reproduction). Larger body limit for the event stream.
  fastify.post('/recordings', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const identity = await resolveCustomer(request)
    const parsed = RecordingSchema.safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid recording', code: 'VALIDATION_ERROR' } }

    const [conv] = await db.select({ id: conversations.id }).from(conversations).where(and(
      eq(conversations.client_id, identity.clientId),
      eq(conversations.external_customer_id, identity.customerId),
      eq(conversations.status, 'open'),
    )).limit(1)

    const [row] = await db.insert(recordings).values({
      client_id: identity.clientId,
      conversation_id: conv?.id ?? null,
      events_json: parsed.data.events,
      meta_json: parsed.data.meta ?? {},
      view_token: randomBytes(18).toString('base64url'),
    }).returning({ id: recordings.id })
    reply.status(201)
    return { data: { id: row.id } }
  })

  fastify.post('/chat', async (request, reply) => {
    const identity = await resolveCustomer(request)   // throws 401 on bad token
    const parsed = ChatSchema.safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid request', details: parsed.error.flatten() } }

    // Find or open a conversation for this (client, customer).
    let [conv] = await db.select().from(conversations).where(and(
      eq(conversations.client_id, identity.clientId),
      eq(conversations.external_customer_id, identity.customerId),
      eq(conversations.status, 'open'),
    )).limit(1)
    if (!conv) {
      // Capture session context (url, ip, location, browser, …) once, at open.
      const context = await buildTicketContext(request, parsed.data.context)
      ;[conv] = await db.insert(conversations).values({
        client_id: identity.clientId,
        external_customer_id: identity.customerId,
        customer_email: identity.email ?? null,
        customer_domain: emailDomain(identity.email),   // for org (domain) ticket visibility
        context_json: context,
      }).returning()
    }

    await db.insert(messages).values({ conversation_id: conv.id, role: 'customer', content: parsed.data.message })

    // Load prior turns + the client's mapped knowledge spaces.
    const history = await db.select().from(messages)
      .where(eq(messages.conversation_id, conv.id))
      .orderBy(asc(messages.created_at))
    const spaceRows = await db.select().from(clientSpaces).where(eq(clientSpaces.client_id, identity.clientId))
    const [client] = await db.select().from(clients).where(eq(clients.id, identity.clientId)).limit(1)
    if (!client) { reply.status(404); return { error: 'Client not found' } }

    const ctx: AgentContext = {
      clientId: identity.clientId,
      customerId: identity.customerId,
      // Only PUBLIC help spaces reach the agent. Internal docs never do.
      helpSpaceIds: spaceRows.filter(s => s.role === 'help').map(s => s.briefly_space_id),
      // This client's own Briefly connection (per-tenant credentials).
      briefly: brieflyClientFor(client),
    }
    const result = await runAgentTurn(
      ctx,
      history.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'customer' | 'agent', content: m.content })),
      parsed.data.message,
    )

    await db.insert(messages).values({ conversation_id: conv.id, role: 'agent', content: result.reply })

    return { data: { conversation_id: conv.id, reply: result.reply, proposed_ticket: result.proposedTicket ?? null } }
  })

  // Gated ticket write: confirm a drafted ticket → create the Brief in Briefly.
  // Kept separate from /chat so a ticket is never filed without an explicit step.
  fastify.post('/chat/tickets/confirm', async (request, reply) => {
    const identity = await resolveCustomer(request)
    const parsed = ConfirmTicketSchema.safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid request', details: parsed.error.flatten() } }

    // Confirm the conversation belongs to this customer (no cross-customer writes).
    const [conv] = await db.select().from(conversations).where(and(
      eq(conversations.id, parsed.data.conversation_id),
      eq(conversations.client_id, identity.clientId),
      eq(conversations.external_customer_id, identity.customerId),
    )).limit(1)
    if (!conv) { reply.status(404); return { error: 'Conversation not found' } }

    // Route to the client's configured ticket destination (briefly today).
    const [client] = await db.select().from(clients).where(eq(clients.id, identity.clientId)).limit(1)
    if (!client) { reply.status(404); return { error: 'Client not found' } }
    const briefly = brieflyClientFor(client)
    const sink = getTicketSink(client.ticket_destination, briefly)

    // Merge stored session context with anything sent at confirm (e.g. an attachment),
    // then re-derive server-side fields (fresh IP/location).
    const stored = (conv.context_json ?? {}) as ClientContext
    const context = await buildTicketContext(request, { ...stored, ...(parsed.data.context ?? {}) })

    // Retrieve INTERNAL docs for engineers — server-side, so the model never sees them.
    const spaceRows = await db.select().from(clientSpaces).where(eq(clientSpaces.client_id, identity.clientId))
    const internalSpaceIds = spaceRows.filter(s => s.role === 'internal').map(s => s.briefly_space_id)
    const internalHits = await searchSpaces(briefly, internalSpaceIds, `${parsed.data.title} ${parsed.data.description}`)
    const internalContext = internalHits.length ? internalHits.join('\n') : undefined

    // Full conversation transcript, saved with the ticket.
    const convMsgs = await db.select().from(messages)
      .where(eq(messages.conversation_id, conv.id)).orderBy(asc(messages.created_at))
    const transcript = convMsgs.map(m => `[${m.role}] ${m.content}`).join('\n')

    // Reproduction replay — build a tokenized link an engineer can open.
    let recordingUrl: string | undefined
    if (parsed.data.recording_id) {
      const [rec] = await db.select({ token: recordings.view_token }).from(recordings)
        .where(and(eq(recordings.id, parsed.data.recording_id), eq(recordings.client_id, identity.clientId))).limit(1)
      if (rec) recordingUrl = `${config.publicUrl}/replay/${parsed.data.recording_id}?t=${rec.token}`
    }

    // AI auto-diagnosis — root cause + category/severity, attached to the ticket.
    const diagnosis = await diagnose({
      title: parsed.data.title,
      description: parsed.data.description,
      transcript,
      diagnostics: parsed.data.diagnostics,
      internalContext,
      url: context.url,
    })

    try {
      const result = await sink.createTicket({
        title: parsed.data.title,
        description: parsed.data.description,
        clientId: identity.clientId,
        conversationId: conv.id,
        customerId: identity.customerId,
        customerEmail: identity.email,
        customerName: identity.name,
        context,
        internalContext,
        transcript,
        diagnostics: parsed.data.diagnostics,
        recordingUrl,
        diagnosis: diagnosis ?? undefined,
      })
      const [row] = await db.insert(tickets).values({
        conversation_id: conv.id,
        destination: result.destination,
        external_id: result.externalId,
        url: result.url ?? null,
        title: parsed.data.title,
        status: 'created',
        recording_id: parsed.data.recording_id ?? null,
      }).returning()
      await db.update(conversations).set({ status: 'escalated' }).where(eq(conversations.id, conv.id))
      return { data: { ticket: row } }
    } catch (err) {
      // Record the failed attempt for observability.
      await db.insert(tickets).values({
        conversation_id: conv.id, destination: client.ticket_destination, title: parsed.data.title, status: 'failed',
      })
      if (err instanceof TicketSinkError) {
        reply.status(err.statusCode)
        return { error: err.message, code: err.code }
      }
      reply.status(502)
      return { error: 'Could not create ticket', detail: err instanceof Error ? err.message : String(err) }
    }
  })

  // The customer's own tickets, with LIVE status pulled from Briefly (like JSM's
  // "my requests" — they see updates as the support team works the ticket).
  fastify.get('/tickets', async (request, reply) => {
    const identity = await resolveCustomer(request)
    const [client] = await db.select().from(clients).where(eq(clients.id, identity.clientId)).limit(1)
    if (!client) { reply.status(404); return { error: 'Client not found' } }

    // Own tickets, or the whole org's when the customer's domain is a shared org.
    const scope = await resolveTicketScope(identity.clientId, identity.email)
    const visibility = scope.mode === 'org' && scope.domain
      ? eq(conversations.customer_domain, scope.domain)
      : eq(conversations.external_customer_id, identity.customerId)

    const rows = await db.select({
      id: tickets.id, title: tickets.title, status: tickets.status,
      external_id: tickets.external_id, url: tickets.url, created_at: tickets.created_at,
      reporter: conversations.customer_email,
    }).from(tickets)
      .innerJoin(conversations, eq(tickets.conversation_id, conversations.id))
      .where(and(eq(conversations.client_id, identity.clientId), visibility))
      .orderBy(desc(tickets.created_at))

    const briefly = brieflyClientFor(client)
    const data = await Promise.all(rows.map(async t => {
      // Live status/title from the Brief; fall back to the stored values.
      let status = t.status as string
      let title = t.title
      let updated_at: string | null = null
      if (t.external_id) {
        try {
          const b = await briefly.getBrief(t.external_id)
          status = String(b.status ?? status)
          title = String(b.title ?? title)
          updated_at = b.updated_at ?? null
        } catch { /* keep stored values */ }
      }
      return { id: t.id, title, status, url: t.url, created_at: t.created_at, updated_at, reporter: t.reporter ?? null }
    }))
    return { data, shared: scope.mode === 'org' }
  })

  // The reply thread for a ticket — the support team's Brief comments + the customer's replies.
  fastify.get('/tickets/:id/comments', async (request, reply) => {
    const identity = await resolveCustomer(request)
    const { id } = request.params as { id: string }
    const scope = await resolveTicketScope(identity.clientId, identity.email)
    const ticket = await findVisibleTicket(id, identity.clientId, identity.customerId, scope)
    if (!ticket?.external_id) { reply.status(404); return { error: 'Ticket not found' } }

    const [client] = await db.select().from(clients).where(eq(clients.id, identity.clientId)).limit(1)
    if (!client) { reply.status(404); return { error: 'Client not found' } }

    const rows = await brieflyClientFor(client).listComments(ticket.external_id)
    const data = rows.map(c => {
      const m = CUSTOMER_PREFIX_RE.exec(c.body)
      if (!m) return { id: c.id, from: 'support', author: c.author, body: c.body, created_at: c.created_at }
      const authorEmail = m[1] || ''
      const mine = !!identity.email && authorEmail.toLowerCase() === identity.email.toLowerCase()
      return {
        id: c.id,
        from: 'customer',
        author: mine ? 'You' : (authorEmail || 'Customer'),
        body: c.body.slice(m[0].length),
        created_at: c.created_at,
      }
    })
    return { data }
  })

  // Customer posts a reply → a Brief comment in Briefly (marked as from the customer).
  fastify.post('/tickets/:id/comments', async (request, reply) => {
    const identity = await resolveCustomer(request)
    const { id } = request.params as { id: string }
    const parsed = ReplySchema.safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid request', details: parsed.error.flatten() } }

    const scope = await resolveTicketScope(identity.clientId, identity.email)
    const ticket = await findVisibleTicket(id, identity.clientId, identity.customerId, scope)
    if (!ticket?.external_id) { reply.status(404); return { error: 'Ticket not found' } }

    const [client] = await db.select().from(clients).where(eq(clients.id, identity.clientId)).limit(1)
    if (!client) { reply.status(404); return { error: 'Client not found' } }

    try {
      await brieflyClientFor(client).addComment(ticket.external_id, customerPrefix(identity.email) + parsed.data.body)
      return { data: { ok: true } }
    } catch (err) {
      reply.status(502)
      return { error: 'Could not post reply', detail: err instanceof Error ? err.message : String(err) }
    }
  })
}
