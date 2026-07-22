import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './lib/config.js'
import { ensureSchema } from './db/ensureSchema.js'
import { healthRoutes } from './routes/health.js'
import { clientsRoutes } from './routes/clients.js'
import { conversationsRoutes } from './routes/conversations.js'
import { replayRoutes } from './routes/replay.js'
import { mcpRoutes } from './routes/mcp.js'

const server = Fastify({ logger: true })

await server.register(cors, { origin: true })
await server.register(healthRoutes)
await server.register(clientsRoutes, { prefix: '/admin' })   // operator API
await server.register(conversationsRoutes, { prefix: '/api' }) // customer API
await server.register(replayRoutes)                           // GET /replay/:id (HTML)
await server.register(mcpRoutes)                             // POST /mcp — Blink tools-in (Direction A)

try {
  // Ensure raw DDL drizzle-kit doesn't manage (e.g. ticket_number_seq) exists
  // before we start serving, so a fresh deploy can't 500 on the first ticket.
  await ensureSchema()
  await server.listen({ port: config.port, host: '0.0.0.0' })
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
