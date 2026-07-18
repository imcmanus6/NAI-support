/**
 * MCP endpoint (Direction A) — lets Briefly's Blink connect to NAI as a tools-in
 * MCP server. Stateless Streamable HTTP, gated by ADMIN_TOKEN (operator-level).
 * Scoped to one client (config.mcpClientId, else the oldest client).
 *
 * Mirrors briefly/apps/api/src/routes/mcp.ts.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { asc, eq } from 'drizzle-orm'
import { config } from '../lib/config.js'
import { db } from '../db/client.js'
import { clients } from '../db/schema.js'
import { buildSupportMcpServer } from '../services/naiMcpServer.js'

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0' as const, error: { code, message }, id: null })

function tokenOk(provided: string, expected: string): boolean {
  if (!expected || !provided) return false
  const a = Buffer.from(provided), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function mcpRoutes(fastify: FastifyInstance) {
  fastify.post('/mcp', async (request, reply) => {
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    if (!tokenOk(token, config.adminToken)) {
      return reply.status(401).send(rpcError(-32001, 'Unauthorized: invalid admin token'))
    }

    const [client] = config.mcpClientId
      ? await db.select().from(clients).where(eq(clients.id, config.mcpClientId)).limit(1)
      : await db.select().from(clients).orderBy(asc(clients.created_at)).limit(1)
    if (!client) return reply.status(400).send(rpcError(-32002, 'No client configured for MCP'))

    const server = buildSupportMcpServer(client)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.hijack()
    reply.raw.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}) })
    try {
      await server.connect(transport)
      await transport.handleRequest(request.raw, reply.raw, request.body)
    } catch (err) {
      request.log.error({ err }, '[mcp] request handling failed')
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
        reply.raw.end(JSON.stringify(rpcError(-32603, 'Internal error')))
      }
    }
  })

  const notAllowed = async (_req: unknown, reply: FastifyReply) =>
    reply.status(405).header('Allow', 'POST').send(rpcError(-32000, 'Method not allowed. Use POST.'))
  fastify.get('/mcp', notAllowed)
  fastify.delete('/mcp', notAllowed)
}
