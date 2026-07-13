/**
 * Contextual (semantic) retrieval over Briefly spaces, read via the /api/v1 key. Used two ways:
 *   - the agent searches HELP spaces (public — results may be quoted to customers)
 *   - the server searches INTERNAL spaces at ticket time (results go to engineers only)
 * Both go through searchSpaces(); the caller decides which space ids to pass.
 *
 * Articles are embedded (OpenAI embeddings) over their FULL text — title + description +
 * body (content_json / notes) — not just the title, so a query like "what's on the daily
 * brief" matches an article titled "Daily Page". Article embeddings are cached in-process
 * with a short TTL so we don't re-embed the whole help centre on every question. Falls back
 * to keyword scoring when no OpenAI key is configured (dev) or embedding fails.
 */
import type { BrieflyClient, BrieflyBrief } from '../lib/brieflyClient.js'
import { getOpenAI } from '../lib/openaiClient.js'

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small'
const CACHE_TTL_MS = 5 * 60 * 1000   // re-embed a space's articles at most every 5 min
const MIN_SCORE = 0.15               // drop clearly-irrelevant matches

interface Doc { snippet: string; embedding: number[] }
const cache = new Map<string, { at: number; docs: Doc[] }>()

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
}

/** All the searchable text of an article: title + description + body (notes + content_json). */
function articleText(b: BrieflyBrief): string {
  const parts: string[] = [b.title, b.description ?? '']
  const notes = (b as { notes?: unknown }).notes
  if (typeof notes === 'string') parts.push(notes)
  const content = (b.content_json ?? {}) as Record<string, unknown>
  for (const v of Object.values(content)) {
    if (typeof v === 'string' && v !== notes) parts.push(stripHtml(v))
  }
  return parts.filter(Boolean).join('\n').slice(0, 8000)
}

/** A readable chunk to hand the agent so it can answer from the article. */
function snippetOf(b: BrieflyBrief): string {
  return `${b.title}\n${stripHtml(articleText(b).slice(b.title.length)).slice(0, 1500)}`.trim()
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

type OpenAIClient = NonNullable<ReturnType<typeof getOpenAI>>
async function embed(openai: OpenAIClient, input: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input })
  return res.data.map(d => d.embedding as number[])
}

async function loadDocs(briefly: BrieflyClient, spaceIds: string[], openai: OpenAIClient): Promise<Doc[]> {
  const key = [...spaceIds].sort().join(',')
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.docs

  const briefs: BrieflyBrief[] = []
  for (const spaceId of spaceIds) {
    const page = await briefly.listBriefs(spaceId, { limit: 200 })
    briefs.push(...page.data.filter(b => articleText(b).trim().length > 0))
  }
  if (!briefs.length) { cache.set(key, { at: Date.now(), docs: [] }); return [] }

  const embeddings = await embed(openai, briefs.map(articleText))
  const docs = briefs.map((b, i) => ({ snippet: snippetOf(b), embedding: embeddings[i] }))
  cache.set(key, { at: Date.now(), docs })
  return docs
}

/** Keyword fallback (no embeddings) — now also scans the article body, not just the title. */
async function keywordSearch(briefly: BrieflyClient, spaceIds: string[], query: string, limit: number): Promise<string[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
  const hits: { snippet: string; score: number }[] = []
  for (const spaceId of spaceIds) {
    const page = await briefly.listBriefs(spaceId, { limit: 200 })
    for (const b of page.data) {
      const hay = articleText(b).toLowerCase()
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
      if (score > 0) hits.push({ snippet: snippetOf(b), score })
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(h => h.snippet)
}

export async function searchSpaces(
  briefly: BrieflyClient,
  spaceIds: string[],
  query: string,
  limit = 5,
): Promise<string[]> {
  if (!spaceIds.length) return []
  const openai = getOpenAI()
  if (!openai) return keywordSearch(briefly, spaceIds, query, limit)
  try {
    const docs = await loadDocs(briefly, spaceIds, openai)
    if (!docs.length) return []
    const [q] = await embed(openai, [query])
    return docs
      .map(d => ({ snippet: d.snippet, score: cosine(q, d.embedding) }))
      .sort((a, b) => b.score - a.score)
      .filter(r => r.score > MIN_SCORE)
      .slice(0, limit)
      .map(r => r.snippet)
  } catch {
    return keywordSearch(briefly, spaceIds, query, limit)
  }
}
