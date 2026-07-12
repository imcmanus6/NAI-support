/**
 * Session context captured for support tickets — the diagnostic metadata a human
 * needs to action a report (like Jira/Intercom auto-capture).
 *
 * Client-side bits (url, screen, timezone, language, referrer, raw user agent) are
 * sent by the widget; server-side bits (ip address, coarse location) are derived
 * here from the request. Browser/OS are parsed from the user agent.
 *
 * Privacy note: IP and location are personal data. They're stored on the
 * conversation and copied into the ticket only. Don't log them elsewhere.
 */
import type { FastifyRequest } from 'fastify'

/** What the widget sends. All optional — never trust it for anything security-sensitive. */
export interface ClientContext {
  url?: string
  referrer?: string
  language?: string
  timezone?: string
  screen?: string          // "1920x1080"
  userAgent?: string
  attachment?: { name: string; type: string; size: number }  // metadata only (see note in ticketSink)
}

/** The full, enriched context stored on the conversation and attached to tickets. */
export interface TicketContext extends ClientContext {
  ipAddress?: string
  browser?: string
  os?: string
  location?: string        // coarse, from geo lookup; falls back to timezone hint
}

/** Extract the client IP, honouring a proxy's X-Forwarded-For (first hop). */
export function clientIp(request: FastifyRequest): string | undefined {
  const xff = request.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim()
  if (Array.isArray(xff) && xff.length) return xff[0].split(',')[0].trim()
  return request.ip || undefined
}

/** Tiny, dependency-free UA parse — good enough for a support context line. */
export function parseUserAgent(ua?: string): { browser?: string; os?: string } {
  if (!ua) return {}
  let browser: string | undefined
  const b =
    /Edg\/([\d.]+)/.exec(ua) ? ['Edge', /Edg\/([\d.]+)/.exec(ua)![1]] :
    /OPR\/([\d.]+)/.exec(ua) ? ['Opera', /OPR\/([\d.]+)/.exec(ua)![1]] :
    /Firefox\/([\d.]+)/.exec(ua) ? ['Firefox', /Firefox\/([\d.]+)/.exec(ua)![1]] :
    /Chrome\/([\d.]+)/.exec(ua) ? ['Chrome', /Chrome\/([\d.]+)/.exec(ua)![1]] :
    /Version\/([\d.]+).*Safari/.exec(ua) ? ['Safari', /Version\/([\d.]+).*Safari/.exec(ua)![1]] :
    undefined
  if (b) browser = `${b[0]} ${b[1].split('.')[0]}`

  let os: string | undefined
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS'
  else if (/Mac OS X/.test(ua)) os = 'macOS'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/Linux/.test(ua)) os = 'Linux'
  return { browser, os }
}

/**
 * Coarse location from IP. Pluggable — no external lookup by default (that would
 * send the user's IP to a third party). Wire ipinfo/MaxMind here when ready.
 */
export async function geoLocate(_ip?: string): Promise<string | undefined> {
  // TODO(geo): call ipinfo.io / MaxMind GeoLite2 and return e.g. "London, GB".
  return undefined
}

/** Merge client-sent context with server-derived IP, browser/OS, and location. */
export async function buildTicketContext(
  request: FastifyRequest,
  client: ClientContext | undefined,
): Promise<TicketContext> {
  const ipAddress = clientIp(request)
  const { browser, os } = parseUserAgent(client?.userAgent ?? request.headers['user-agent'])
  const location = (await geoLocate(ipAddress)) ?? (client?.timezone ? `~${client.timezone}` : undefined)
  return { ...(client ?? {}), ipAddress, browser, os, location }
}

/** Passive diagnostics captured on the HOST page (console/network/errors) around the issue. */
export interface Diagnostics {
  console?: { level: string; message: string }[]
  network?: { method: string; url: string; status: number; ms: number }[]
  errors?: { message: string }[]
}

/** Formats captured diagnostics into an engineer-readable block (or '' if empty). */
export function formatDiagnosticsBlock(d: Diagnostics | undefined): string {
  if (!d) return ''
  const parts: string[] = []
  if (d.errors?.length) parts.push('Errors:\n' + d.errors.map(e => `  • ${e.message}`).join('\n'))
  if (d.console?.length) parts.push('Console:\n' + d.console.map(c => `  [${c.level}] ${c.message}`).join('\n'))
  if (d.network?.length) parts.push('Network:\n' + d.network.map(n => `  ${n.status} ${n.method} ${n.url} (${n.ms}ms)`).join('\n'))
  return parts.length ? `\n\n— Recording (browser diagnostics) —\n${parts.join('\n\n')}` : ''
}

/** Human-readable block appended to a ticket description. */
export function formatContextBlock(ctx: TicketContext): string {
  const lines: string[] = []
  if (ctx.url) lines.push(`Page: ${ctx.url}`)
  if (ctx.browser || ctx.os) lines.push(`Browser: ${[ctx.browser, ctx.os].filter(Boolean).join(' on ')}`)
  const loc = [ctx.ipAddress && `IP ${ctx.ipAddress}`, ctx.location && `Location ${ctx.location}`].filter(Boolean).join(' · ')
  if (loc) lines.push(loc)
  const env = [ctx.language && `Lang ${ctx.language}`, ctx.screen && `Screen ${ctx.screen}`, ctx.timezone && `TZ ${ctx.timezone}`].filter(Boolean).join(' · ')
  if (env) lines.push(env)
  if (ctx.referrer) lines.push(`Referrer: ${ctx.referrer}`)
  if (ctx.attachment) lines.push(`Attachment: ${ctx.attachment.name} (${ctx.attachment.type}, ${ctx.attachment.size} bytes)`)
  return lines.length ? `\n\n— Session context —\n${lines.join('\n')}` : ''
}
