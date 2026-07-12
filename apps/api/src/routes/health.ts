import type { FastifyInstance } from 'fastify'

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => ({ ok: true, service: 'support-ai/api' }))
}
