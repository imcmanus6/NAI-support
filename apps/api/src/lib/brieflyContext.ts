/**
 * Direction B — consume Briefly's Context Engine (search_context) over MCP.
 *
 * Instead of NAI's local embedding search over raw briefs, this asks Briefly for a
 * ranked, authority-filtered, access-controlled context package — scoped by a
 * Context Pack (the pack-scoped key in BRIEFLY_MCP_KEY defines which spaces are in
 * play, e.g. just the public help KB).
 *
 * INERT + FAIL-OPEN: if not configured, or the call fails, returns [] and the
 * caller falls back to its existing local search — so answering never breaks.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { config } from './config.js'

const CONNECT_TIMEOUT_MS = 6000
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('briefly MCP timed out')), ms))])

/** Whether Direction B is configured. */
export const brieflyContextEnabled = (): boolean => !!(config.brieflyMcp.url && config.brieflyMcp.key)

/**
 * Ask Briefly's Context Engine for context on `query`. Returns the assembled context
 * as a single string chunk (or [] when unconfigured / on any error).
 */
export async function searchBrieflyContext(query: string): Promise<string[]> {
  const { url, key } = config.brieflyMcp
  if (!url || !key) return []

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  })
  const client = new Client({ name: 'nai-support', version: '1.0.0' })
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS)
    const res = await withTimeout(
      client.callTool({ name: 'search_context', arguments: { query } }),
      CONNECT_TIMEOUT_MS,
    ) as { content?: Array<{ type: string; text?: string }> }
    const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    return text ? [text] : []
  } catch (err) {
    console.error(`[briefly-context] falling back to local search: ${err instanceof Error ? err.message : String(err)}`)
    return []
  } finally {
    await client.close().catch(() => {})
  }
}
