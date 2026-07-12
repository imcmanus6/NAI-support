/**
 * Ticket destination abstraction. The agent/route never care WHERE a ticket goes —
 * they hand a draft to the sink selected by the client's `ticket_destination`.
 * Today only Briefly is wired; Jira is a selectable setting whose sink throws
 * NOT_IMPLEMENTED until we build it. Adding Jira later is a new class, not a rewrite.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { clientSpaces } from '../db/schema.js'
import type { BrieflyClient } from '../lib/brieflyClient.js'
import { formatContextBlock, formatDiagnosticsBlock, type TicketContext, type Diagnostics } from '../lib/requestContext.js'
import { formatDiagnosisBlock, kpiCategory, type Diagnosis } from './diagnose.js'

export type TicketDestination = 'briefly' | 'jira'

export interface TicketDraft {
  title: string
  description: string
  clientId: string
  conversationId: string
  customerId: string
  customerEmail?: string         // from the verified identity token
  customerName?: string
  context?: TicketContext        // auto-captured session metadata (url, ip, browser, …)
  internalContext?: string       // engineer-only docs retrieved server-side (never customer-visible)
  transcript?: string            // the full support conversation
  diagnostics?: Diagnostics      // host-page console/network/errors captured around the issue
  recordingUrl?: string          // link to an rrweb reproduction replay
  diagnosis?: Diagnosis          // AI root-cause analysis
}

export interface TicketResult {
  destination: TicketDestination
  externalId: string          // brief id (Briefly) or issue key (Jira)
  url?: string
}

export interface TicketSink {
  createTicket(draft: TicketDraft): Promise<TicketResult>
}

/** Carries an HTTP-ish status so the route can translate cleanly. */
export class TicketSinkError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message)
    this.name = 'TicketSinkError'
  }
}

/** Files tickets as Briefs into the client's specific space. */
class BrieflyTicketSink implements TicketSink {
  constructor(private readonly briefly: BrieflyClient) {}

  async createTicket(draft: TicketDraft): Promise<TicketResult> {
    const [target] = await db.select().from(clientSpaces).where(and(
      eq(clientSpaces.client_id, draft.clientId),
      eq(clientSpaces.role, 'tickets'),
    )).limit(1)
    if (!target) {
      throw new TicketSinkError(409, 'NO_TICKET_SPACE', 'No ticket space configured for this client.')
    }

    // Build the description: customer detail, then auto-captured session context, then
    // engineer-only internal docs. Internal context is retrieved server-side and only
    // ever appears here in the ticket — the model never sees it. (Binary attachments are
    // metadata-only for now — Briefly's /api/v1 has no attachment upload endpoint.)
    const reportedBy = (draft.customerName || draft.customerEmail)
      ? `Reported by: ${[draft.customerName, draft.customerEmail].filter(Boolean).join(' · ')}\n\n`
      : ''
    const description = reportedBy + draft.description
      + (draft.diagnosis ? formatDiagnosisBlock(draft.diagnosis) : '')
      + (draft.recordingUrl ? `\n\n🎥 Reproduction replay: ${draft.recordingUrl}` : '')
      + (draft.context ? formatContextBlock(draft.context) : '')
      + (draft.transcript ? `\n\n— Conversation —\n${draft.transcript}` : '')
      + formatDiagnosticsBlock(draft.diagnostics)
      + (draft.internalContext ? `\n\n— Internal context (engineers only) —\n${draft.internalContext}` : '')
    const brief = await this.briefly.createBrief({
      space_id: target.briefly_space_id,
      title: draft.title,
      brief_type: 'action',
      description,
      properties: {
        source: 'support-ai',
        conversation_id: draft.conversationId,
        customer_id: draft.customerId,
        customer_email: draft.customerEmail ?? null,
        customer_name: draft.customerName ?? null,
        context: draft.context ?? {},
        transcript: draft.transcript ?? null,
        diagnostics: draft.diagnostics ?? null,
        // Feeds the ticketing KPI dashboard (bug / feature / question) + severity.
        ...(draft.diagnosis ? {
          category: kpiCategory(draft.diagnosis.category),
          severity: draft.diagnosis.severity,
          customer_resolvable: draft.diagnosis.customer_resolvable,
        } : {}),
      },
    })
    const url = typeof brief.url === 'string' ? brief.url : undefined
    return { destination: 'briefly', externalId: brief.id, url }
  }
}

/** Placeholder — the setting is selectable but the integration is not built yet. */
class JiraTicketSink implements TicketSink {
  async createTicket(): Promise<TicketResult> {
    throw new TicketSinkError(501, 'NOT_IMPLEMENTED', 'Jira ticketing is not enabled yet. Set the client destination to Briefly.')
  }
}

export function getTicketSink(destination: TicketDestination, briefly: BrieflyClient): TicketSink {
  switch (destination) {
    case 'briefly': return new BrieflyTicketSink(briefly)
    case 'jira': return new JiraTicketSink()
    default: throw new TicketSinkError(400, 'BAD_DESTINATION', `Unknown ticket destination: ${destination}`)
  }
}
