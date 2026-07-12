/**
 * External-customer identity. End-customers are UNTRUSTED — the whole security
 * model hinges on this file. The verified customer id it returns is the ONLY
 * thing allowed to scope software-DB queries (see services/softwareDb.ts).
 *
 * The host product (e.g. Briefly) mints a short-lived HS256 token signed with a
 * secret we share (CUSTOMER_TOKEN_SECRET). We verify that signature here — so we
 * trust "this really is user X" without the user ever handling a password.
 *
 * Swapping the issuer later (e.g. a shared SSO) is contained to this file: callers
 * only ever see `CustomerIdentity`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { clients } from '../db/schema.js'
import { config } from './config.js'

export interface CustomerIdentity {
  clientId: string          // which AI-service client this customer belongs to
  customerId: string        // stable id in the host product — scopes all data access
  email?: string
  name?: string
}

function httpError(statusCode: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number }
  err.statusCode = statusCode
  return err
}

/** Verify an HS256 token against the shared secret; returns the payload or null. */
function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null
  return payload
}

/** Decode the payload WITHOUT verifying — only to read `client_key` and pick the secret. */
function peekPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

type ClientRow = typeof clients.$inferSelect

/**
 * Resolve which host software (client) this token belongs to. Multi-tenant: the
 * token's `client_key` names the client; we look it up and use ITS secret to
 * verify. Single-tenant fallback: if there's exactly one client, use it.
 */
async function resolveClient(payload: Record<string, unknown>): Promise<ClientRow> {
  const key = typeof payload.client_key === 'string' ? payload.client_key : undefined
  if (key) {
    const [c] = await db.select().from(clients).where(eq(clients.client_key, key)).limit(1)
    if (!c) throw httpError(401, `Unknown client: ${key}`)
    return c
  }
  const rows = await db.select().from(clients).limit(2)
  if (rows.length === 1) return rows[0]
  throw httpError(400, 'Cannot resolve client (token missing client_key)')
}

export async function resolveCustomer(request: FastifyRequest): Promise<CustomerIdentity> {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) throw httpError(401, 'Missing customer token')
  const token = header.slice('Bearer '.length).trim()

  const peeked = peekPayload(token)
  if (!peeked) throw httpError(401, 'Malformed customer token')

  const client = await resolveClient(peeked)
  // Prefer the client's own secret; fall back to the global env for single-tenant.
  const secret = client.token_secret ?? config.customerToken.secret
  if (!secret) throw httpError(501, `No token secret configured for client "${client.name}".`)

  const payload = verifyToken(token, secret)   // NOW verify the signature with the right secret
  if (!payload) throw httpError(401, 'Invalid or expired customer token')

  // Optional issuer pin — only enforced when configured.
  if (config.customerToken.issuer && payload.iss !== config.customerToken.issuer) {
    throw httpError(401, 'Untrusted token issuer')
  }

  const customerId = payload.sub as string | undefined
  if (!customerId) throw httpError(401, 'Token missing sub (user id)')

  return {
    clientId: client.id,
    customerId,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  }
}
