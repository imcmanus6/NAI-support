/**
 * Typed client for Briefly's external API (/api/v1). This is the ONLY way this
 * product reads or writes Briefly data — no shared database, no shared code.
 * Authenticated by a hub-scoped API key (BRIEFLY_API_KEY).
 *
 * Mirrors the endpoints defined in briefly: apps/api/src/routes/v1.ts.
 */
import { config } from './config.js'

export interface BrieflySpace {
  id: string
  name: string
  description: string | null
  space_type: string
  icon: string | null
  parent_space_id: string | null
  updated_at: string
}

// Briefs are returned in Briefly's BriefDto shape; we type the fields we use and
// keep the rest open. Extend as the agent needs more.
export interface BrieflyBrief {
  id: string
  title: string
  brief_type: string
  description?: string | null
  status?: string
  space_id?: string | null
  content_json?: Record<string, unknown>
  properties_json?: Record<string, unknown>
  updated_at: string
  [key: string]: unknown
}

export interface BriefFeedPage {
  data: BrieflyBrief[]
  next_cursor: string | null
  has_more: boolean
}

export interface CreateBriefInput {
  space_id: string
  title: string
  brief_type?: 'action' | 'document' | 'report' | 'decision' | 'meeting' | 'custom'
  description?: string
  priority?: 'urgent_important' | 'today' | 'important_not_urgent' | 'low_priority' | 'delegated'
  content?: Record<string, unknown>
  properties?: Record<string, unknown>
}

export class BrieflyApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'BrieflyApiError'
  }
}

export class BrieflyClient {
  constructor(
    private readonly baseUrl = config.briefly.apiUrl,
    private readonly apiKey = config.briefly.apiKey,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      throw new BrieflyApiError(
        res.status,
        (body.code as string) ?? 'ERROR',
        (body.error as string) ?? `Briefly API ${res.status}`,
      )
    }
    return body as T
  }

  /** All spaces in the key's hub — used by the admin UI's space picker. */
  async listSpaces(): Promise<BrieflySpace[]> {
    const res = await this.request<{ data: BrieflySpace[] }>('/api/v1/spaces')
    return res.data
  }

  /** One page of a space's briefs. Pass `updatedSince` (a prior next_cursor) to poll incrementally. */
  async listBriefs(spaceId: string, opts: { updatedSince?: string; limit?: number } = {}): Promise<BriefFeedPage> {
    const q = new URLSearchParams()
    if (opts.updatedSince) q.set('updated_since', opts.updatedSince)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString() ? `?${q.toString()}` : ''
    return this.request<BriefFeedPage>(`/api/v1/spaces/${spaceId}/briefs${qs}`)
  }

  /** Drain a space's full feed across pages (use for an initial knowledge sync). */
  async *iterateBriefs(spaceId: string, opts: { updatedSince?: string } = {}): AsyncGenerator<BrieflyBrief> {
    let cursor = opts.updatedSince
    for (;;) {
      const page = await this.listBriefs(spaceId, { updatedSince: cursor, limit: 200 })
      for (const brief of page.data) yield brief
      if (!page.has_more || !page.next_cursor) return
      cursor = page.next_cursor
    }
  }

  async getBrief(briefId: string): Promise<BrieflyBrief> {
    const res = await this.request<{ data: BrieflyBrief }>(`/api/v1/briefs/${briefId}`)
    return res.data
  }

  /** Initiate a brief (the day-one ticket write). */
  async createBrief(input: CreateBriefInput): Promise<BrieflyBrief> {
    const res = await this.request<{ data: BrieflyBrief }>('/api/v1/briefs', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return res.data
  }

  /** Attach a file (e.g. a ticket screenshot) to a brief — multipart, not JSON. */
  async uploadAttachment(briefId: string, filename: string, contentType: string, data: Buffer): Promise<{ id: string; url: string }> {
    const fd = new FormData()
    fd.append('file', new Blob([data], { type: contentType }), filename)
    // Let fetch set the multipart Content-Type (with boundary) — don't force JSON here.
    const res = await fetch(`${this.baseUrl}/api/v1/briefs/${briefId}/attachments`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: fd,
    })
    const body = (await res.json().catch(() => ({}))) as { data?: { id: string; url: string }; error?: string; code?: string }
    if (!res.ok) throw new BrieflyApiError(res.status, body.code ?? 'ERROR', body.error ?? `Briefly API ${res.status}`)
    return body.data as { id: string; url: string }
  }

  /** Comments on a brief — the ticket reply thread. */
  async listComments(briefId: string): Promise<BrieflyComment[]> {
    const res = await this.request<{ data: BrieflyComment[] }>(`/api/v1/briefs/${briefId}/comments`)
    return res.data
  }

  async addComment(briefId: string, body: string): Promise<void> {
    await this.request(`/api/v1/briefs/${briefId}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
  }
}

export interface BrieflyComment {
  id: string
  body: string
  author: string
  created_at: string
}

/**
 * A client bound to the ENV credentials (single-tenant / dogfood default).
 * Multi-tenant callers should use `brieflyClientFor(client)` instead.
 */
export const briefly = new BrieflyClient()

/** Build a BrieflyClient for a specific client row, falling back to env creds. */
export function brieflyClientFor(client: {
  briefly_api_url: string | null
  briefly_api_key: string | null
}): BrieflyClient {
  return new BrieflyClient(
    client.briefly_api_url ?? config.briefly.apiUrl,
    client.briefly_api_key ?? config.briefly.apiKey,
  )
}
