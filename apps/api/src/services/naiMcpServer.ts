/**
 * NAI as an MCP SERVER (Direction A) — exposes NAI's support operations as MCP tools
 * so Briefly's Blink (an MCP client, "tools-in") can query the support agent directly.
 *
 * Scoped to ONE client (resolved by the route). Read-only + NAI-unique surface:
 * support conversations and the customer-facing help KB. Tickets deliberately are
 * NOT here — they live in Briefly, so Blink already has them natively.
 *
 * Mirrors the stateless Streamable-HTTP MCP pattern used in briefly/apps/api.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { clients, clientSpaces, conversations, messages } from '../db/schema.js'
import { brieflyClientFor } from '../lib/brieflyClient.js'
import { searchSpaces } from './knowledge.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
const text = (s: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: s }], isError })

type ClientRow = typeof clients.$inferSelect

export function buildSupportMcpServer(client: ClientRow): McpServer {
  const server = new McpServer(
    { name: 'nai-support', version: '1.0.0' },
    {
      instructions:
        `You are connected to the NAI support agent for "${client.name}". Use these tools to see live ` +
        'customer support activity (conversations) and what the customer-facing help knowledge base says. ' +
        'Read-only — to change a ticket, use Briefly directly (tickets are filed there).',
    },
  )

  // ── list_support_conversations ────────────────────────────────────────────────
  server.registerTool(
    'list_support_conversations',
    {
      title: 'List support conversations',
      description: 'Recent customer support conversations handled by the AI support agent, newest first. ' +
        'Optionally filter by status (open/closed/escalated).',
      inputSchema: {
        status: z.enum(['open', 'resolved', 'escalated']).optional().describe('Filter by conversation status.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max conversations (default 20).'),
      },
    },
    async ({ status, limit }) => {
      const where = status
        ? and(eq(conversations.client_id, client.id), eq(conversations.status, status))
        : eq(conversations.client_id, client.id)
      const rows = await db.select({
        id: conversations.id, customer: conversations.customer_email, ext: conversations.external_customer_id,
        status: conversations.status, updated: conversations.updated_at,
      }).from(conversations).where(where).orderBy(desc(conversations.updated_at)).limit(limit ?? 20)
      if (!rows.length) return text('No support conversations found.')
      const body = rows.map(r =>
        `• ${r.customer || r.ext} — ${r.status} · updated ${r.updated.toISOString().slice(0, 16).replace('T', ' ')}\n  conversation_id: ${r.id}`,
      ).join('\n')
      return text(`Support conversations (${rows.length}):\n\n${body}`)
    },
  )

  // ── get_support_conversation ──────────────────────────────────────────────────
  server.registerTool(
    'get_support_conversation',
    {
      title: 'Get a support conversation',
      description: 'Full transcript of one support conversation by id (from list_support_conversations).',
      inputSchema: { conversation_id: z.string().uuid().describe('The conversation id.') },
    },
    async ({ conversation_id }) => {
      const [conv] = await db.select().from(conversations)
        .where(and(eq(conversations.id, conversation_id), eq(conversations.client_id, client.id))).limit(1)
      if (!conv) return text('Conversation not found for this client.', true)
      const msgs = await db.select({ role: messages.role, content: messages.content, at: messages.created_at })
        .from(messages).where(eq(messages.conversation_id, conversation_id)).orderBy(messages.created_at)
      const head = `Customer: ${conv.customer_email || conv.external_customer_id} · status ${conv.status}`
      const body = msgs.map(m => `[${m.role}] ${m.content}`).join('\n\n')
      return text(`${head}\n\n---\n\n${body || '(no messages)'}`)
    },
  )

  // ── search_support_kb ─────────────────────────────────────────────────────────
  server.registerTool(
    'search_support_kb',
    {
      title: 'Search the support knowledge base',
      description: "Search this client's customer-facing help knowledge base — the same articles the AI " +
        'support agent quotes to customers. Use to see what a customer would be told about a topic.',
      inputSchema: { query: z.string().min(1).describe('What to look up in the help KB.') },
    },
    async ({ query }) => {
      const spaceRows = await db.select({ sid: clientSpaces.briefly_space_id })
        .from(clientSpaces).where(eq(clientSpaces.client_id, client.id))
      const spaceIds = spaceRows.map(r => r.sid)
      if (!spaceIds.length) return text('No help spaces are configured for this client.')
      const results = await searchSpaces(brieflyClientFor(client), spaceIds, query)
      return text(results.length ? results.join('\n\n---\n\n') : 'No matching help articles found.')
    },
  )

  return server
}
