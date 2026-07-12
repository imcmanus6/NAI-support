import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './lib/config.js'
import { healthRoutes } from './routes/health.js'
import { clientsRoutes } from './routes/clients.js'
import { conversationsRoutes } from './routes/conversations.js'
import { replayRoutes } from './routes/replay.js'

const server = Fastify({ logger: true })

await server.register(cors, { origin: true })
await server.register(healthRoutes)
await server.register(clientsRoutes, { prefix: '/admin' })   // operator API
await server.register(conversationsRoutes, { prefix: '/api' }) // customer API
await server.register(replayRoutes)                           // GET /replay/:id (HTML)

try {
  await server.listen({ port: config.port, host: '0.0.0.0' })
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
