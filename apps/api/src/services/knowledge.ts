/**
 * Keyword retrieval over Briefly spaces (read via the /api/v1 key). Used two ways:
 *   - the agent searches HELP spaces (public — results may be quoted to customers)
 *   - the server searches INTERNAL spaces at ticket time (results go to engineers only)
 * Both go through this one function; the caller decides which space ids to pass.
 * Swap the naive scoring for embeddings later without touching callers.
 */
import type { BrieflyClient } from '../lib/brieflyClient.js'

export async function searchSpaces(
  briefly: BrieflyClient,
  spaceIds: string[],
  query: string,
  limit = 5,
): Promise<string[]> {
  if (!spaceIds.length) return []
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: { text: string; score: number }[] = []
  for (const spaceId of spaceIds) {
    const page = await briefly.listBriefs(spaceId, { limit: 200 })
    for (const b of page.data) {
      const hay = `${b.title} ${b.description ?? ''}`.toLowerCase()
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
      if (score > 0) hits.push({ text: `${b.title}: ${b.description ?? ''}`.trim(), score })
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(h => h.text)
}
