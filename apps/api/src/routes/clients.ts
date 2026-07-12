/**
 * Admin routes — the operator UI configures each host software (client) entirely
 * from here: identity (client_key + token secret), backend credentials, space-role
 * mapping, ticket destination, and the read-only software-DB connection.
 *
 * NOTE: operator-only. Add real admin auth + encrypt secrets at rest before prod;
 * for now these are unauthenticated for local scaffolding, and secrets are masked
 * on read (never echoed back to the browser).
 */
import type { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { clients, clientSpaces, softwareDbConnections, organizations, organizationAdmins } from '../db/schema.js'
import { brieflyClientFor } from '../lib/brieflyClient.js'
import { SoftwareDbConfig } from '../services/softwareDbQuery.js'
import { config } from '../lib/config.js'

/** Constant-time compare of the presented admin token against the configured one. */
function tokenOk(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const CreateClientSchema = z.object({ name: z.string().min(1).max(200) })

const UpdateClientSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  client_key: z.string().min(1).max(120).optional(),
  token_secret: z.string().optional(),            // only applied when non-empty
  briefly_api_url: z.string().optional(),
  briefly_api_key: z.string().optional(),          // only applied when non-empty
  ticket_destination: z.enum(['briefly', 'jira']).optional(),
})

const SetSpacesSchema = z.object({
  spaces: z.array(z.object({
    briefly_space_id: z.string(),
    role: z.enum(['help', 'internal', 'tickets']),
    label: z.string().optional(),
  })).max(20),
})

type ClientRow = typeof clients.$inferSelect

/** Never send secrets to the browser — expose only whether they're set. */
function maskClient(c: ClientRow) {
  return {
    id: c.id,
    name: c.name,
    client_key: c.client_key,
    briefly_hub_id: c.briefly_hub_id,
    briefly_api_url: c.briefly_api_url,
    ticket_destination: c.ticket_destination,
    has_token_secret: !!c.token_secret,
    has_briefly_api_key: !!c.briefly_api_key,
    created_at: c.created_at,
  }
}

const REDACTED = '***'
/** postgres://user:pass@host → postgres://user:***@host */
function redactUrl(url: string): string {
  return url.replace(/(:\/\/[^:@/]+:)([^@]+)(@)/, `$1${REDACTED}$3`)
}

export async function clientsRoutes(fastify: FastifyInstance) {
  // Gate every admin route behind ADMIN_TOKEN (Bearer). No token configured → locked.
  fastify.addHook('preHandler', async (request, reply) => {
    if (!config.adminToken) {
      reply.status(501)
      return reply.send({ error: 'Admin API is not configured (set ADMIN_TOKEN).', code: 'NOT_CONFIGURED' })
    }
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    if (!tokenOk(token, config.adminToken)) {
      reply.status(401)
      return reply.send({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
    }
  })

  fastify.get('/clients', async () => {
    const rows = await db.select().from(clients).orderBy(clients.created_at)
    return { data: rows.map(maskClient) }
  })

  fastify.get('/clients/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1)
    if (!row) { reply.status(404); return { error: 'Client not found' } }
    return { data: maskClient(row) }
  })

  fastify.post('/clients', async (request, reply) => {
    const parsed = CreateClientSchema.safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid request', details: parsed.error.flatten() } }
    const [row] = await db.insert(clients).values({ name: parsed.data.name }).returning()
    reply.status(201)
    return { data: maskClient(row) }
  })

  // Update client identity / credentials. Secrets are only written when non-empty,
  // so leaving them blank keeps the existing value.
  fastify.patch('/clients/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = UpdateClientSchema.safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid request', details: parsed.error.flatten() } }
    const p = parsed.data

    const patch: Partial<ClientRow> = { updated_at: new Date() }
    if (p.name !== undefined) patch.name = p.name
    if (p.client_key !== undefined) patch.client_key = p.client_key || null
    if (p.briefly_api_url !== undefined) patch.briefly_api_url = p.briefly_api_url || null
    if (p.ticket_destination !== undefined) patch.ticket_destination = p.ticket_destination
    if (p.token_secret) patch.token_secret = p.token_secret          // non-empty only
    if (p.briefly_api_key) patch.briefly_api_key = p.briefly_api_key  // non-empty only

    const [row] = await db.update(clients).set(patch).where(eq(clients.id, id)).returning()
    if (!row) { reply.status(404); return { error: 'Client not found' } }
    return { data: maskClient(row) }
  })

  // Spaces available in THIS client's hub (uses the client's own Briefly key).
  fastify.get('/clients/:id/briefly-spaces', async (request, reply) => {
    const { id } = request.params as { id: string }
    const [client] = await db.select().from(clients).where(eq(clients.id, id)).limit(1)
    if (!client) { reply.status(404); return { error: 'Client not found' } }
    try {
      const spaces = await brieflyClientFor(client).listSpaces()
      return { data: spaces }
    } catch (err) {
      reply.status(502)
      return { error: 'Could not list spaces — check the Briefly API key/URL', detail: err instanceof Error ? err.message : String(err) }
    }
  })

  fastify.get('/clients/:id/spaces', async (request) => {
    const { id } = request.params as { id: string }
    const rows = await db.select().from(clientSpaces).where(eq(clientSpaces.client_id, id))
    return { data: rows }
  })

  // Replace a client's space mapping wholesale.
  fastify.put('/clients/:id/spaces', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = SetSpacesSchema.safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid request', details: parsed.error.flatten() } }

    await db.delete(clientSpaces).where(eq(clientSpaces.client_id, id))
    if (parsed.data.spaces.length) {
      await db.insert(clientSpaces).values(parsed.data.spaces.map(s => ({
        client_id: id, briefly_space_id: s.briefly_space_id, role: s.role, label: s.label ?? null,
      })))
    }
    const rows = await db.select().from(clientSpaces).where(eq(clientSpaces.client_id, id))
    return { data: rows }
  })

  // ── Software-DB connection (the differentiator: read the user's real permissions) ──
  fastify.get('/clients/:id/software-db', async (request) => {
    const { id } = request.params as { id: string }
    const [row] = await db.select().from(softwareDbConnections).where(eq(softwareDbConnections.client_id, id)).limit(1)
    if (!row) return { data: null }
    const config = row.config_json as Record<string, unknown>
    // Redact the connection-string password before sending to the browser.
    const safe = { ...config, url: typeof config.url === 'string' ? redactUrl(config.url) : config.url }
    return { data: { config: safe, configured: true } }
  })

  // ── Organizations (group customers by domain; JSM-style shared visibility) ──
  fastify.get('/clients/:id/orgs', async (request) => {
    const { id } = request.params as { id: string }
    const rows = await db.select().from(organizations).where(eq(organizations.client_id, id)).orderBy(organizations.domain)
    return { data: rows }
  })

  fastify.post('/clients/:id/orgs', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({
      domain: z.string().min(1).max(253),
      name: z.string().min(1).max(200),
      share_tickets: z.boolean().default(true),
    }).safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid request', details: parsed.error.flatten() } }
    const domain = parsed.data.domain.trim().toLowerCase()
    try {
      const [row] = await db.insert(organizations).values({
        client_id: id, domain, name: parsed.data.name, share_tickets: parsed.data.share_tickets,
      }).returning()
      reply.status(201)
      return { data: row }
    } catch {
      reply.status(409)
      return { error: `An organization for "${domain}" already exists.` }
    }
  })

  fastify.patch('/orgs/:orgId', async (request, reply) => {
    const { orgId } = request.params as { orgId: string }
    const parsed = z.object({
      name: z.string().min(1).max(200).optional(),
      share_tickets: z.boolean().optional(),
    }).safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid request', details: parsed.error.flatten() } }
    const [row] = await db.update(organizations)
      .set({ ...parsed.data, updated_at: new Date() }).where(eq(organizations.id, orgId)).returning()
    if (!row) { reply.status(404); return { error: 'Organization not found' } }
    return { data: row }
  })

  fastify.delete('/orgs/:orgId', async (request, reply) => {
    const { orgId } = request.params as { orgId: string }
    await db.delete(organizations).where(eq(organizations.id, orgId))
    reply.status(204)
    return null
  })

  fastify.get('/orgs/:orgId/admins', async (request) => {
    const { orgId } = request.params as { orgId: string }
    const rows = await db.select().from(organizationAdmins).where(eq(organizationAdmins.organization_id, orgId)).orderBy(organizationAdmins.email)
    return { data: rows }
  })

  fastify.post('/orgs/:orgId/admins', async (request, reply) => {
    const { orgId } = request.params as { orgId: string }
    const parsed = z.object({ email: z.string().email() }).safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid email' } }
    try {
      const [row] = await db.insert(organizationAdmins)
        .values({ organization_id: orgId, email: parsed.data.email.trim().toLowerCase() }).returning()
      reply.status(201)
      return { data: row }
    } catch {
      reply.status(409)
      return { error: 'That email is already an admin of this org.' }
    }
  })

  fastify.delete('/orgs/:orgId/admins/:adminId', async (request, reply) => {
    const { adminId } = request.params as { adminId: string }
    await db.delete(organizationAdmins).where(eq(organizationAdmins.id, adminId))
    reply.status(204)
    return null
  })

  fastify.put('/clients/:id/software-db', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = SoftwareDbConfig.safeParse(request.body)
    if (!parsed.success) { reply.status(400); return { error: 'Invalid config', details: parsed.error.flatten() } }

    // If the submitted url is still redacted, keep the previously-stored url.
    let url = parsed.data.url
    if (url.includes(REDACTED)) {
      const [existing] = await db.select().from(softwareDbConnections).where(eq(softwareDbConnections.client_id, id)).limit(1)
      const prev = (existing?.config_json as { url?: string } | undefined)?.url
      if (prev) url = prev
    }
    const config = { ...parsed.data, url }

    const [existing] = await db.select().from(softwareDbConnections).where(eq(softwareDbConnections.client_id, id)).limit(1)
    if (existing) {
      await db.update(softwareDbConnections).set({ config_json: config }).where(eq(softwareDbConnections.id, existing.id))
    } else {
      await db.insert(softwareDbConnections).values({ client_id: id, kind: 'postgres', config_json: config })
    }
    return { data: { ok: true } }
  })
}
