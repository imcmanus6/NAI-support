/**
 * Reproduction replay — renders a stored rrweb recording with rrweb-player.
 * Gated by the recording's per-recording view token (?t=…) or the admin token
 * (?token=…). Linked from the ticket Brief so an engineer can watch what the
 * customer did, step by step.
 */
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { recordings } from '../db/schema.js'
import { config } from '../lib/config.js'

const PLAYER = 'https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4/dist'

function esc(s: string): string { return s.replace(/</g, '&lt;') }

function replayHtml(events: unknown, meta: Record<string, unknown>): string {
  const url = typeof meta.url === 'string' ? ' · ' + esc(meta.url) : ''
  // Escape < so recorded DOM containing </script> can't break out of the inline JSON.
  const eventsJson = JSON.stringify(events).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8" /><title>NAI · Replay</title>
<link rel="stylesheet" href="${PLAYER}/style.css" />
<style>
  body { margin: 0; background: #1e1e1e; color: #ccc; font-family: ui-monospace, monospace; }
  .bar { padding: 10px 16px; font-size: 13px; background: #252526; border-bottom: 1px solid #000; }
  .b { color: #7c6cff; font-weight: 700; }
  #p { display: flex; justify-content: center; padding: 16px; }
</style></head>
<body>
  <div class="bar"><span class="b">NAI</span> · reproduction replay${url}</div>
  <div id="p"></div>
  <script src="${PLAYER}/index.js"></script>
  <script>
    var events = ${eventsJson};
    new rrwebPlayer({ target: document.getElementById('p'),
      props: { events: events, autoPlay: false,
        width: Math.min(window.innerWidth - 48, 1280), height: window.innerHeight - 120 } });
  </script>
</body></html>`
}

export async function replayRoutes(fastify: FastifyInstance) {
  fastify.get('/replay/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { t, token } = request.query as { t?: string; token?: string }
    reply.type('text/html')

    const [rec] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1)
    if (!rec) { reply.status(404); return '<h1>Recording not found</h1>' }

    const ok = (t && t === rec.view_token) || (config.adminToken && token === config.adminToken)
    if (!ok) { reply.status(401); return '<h1>Unauthorized</h1><p>This replay link needs its token.</p>' }

    return replayHtml(rec.events_json, (rec.meta_json ?? {}) as Record<string, unknown>)
  })
}
