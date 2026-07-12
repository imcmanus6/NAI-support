/**
 * JSM-style organization visibility. Customers are grouped by email domain into
 * organizations (created deliberately by an operator). Within an org, members can
 * see each other's tickets when share_tickets is on; org admins always can.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { organizations, organizationAdmins } from '../db/schema.js'

/** Lowercased domain of an email, or null. */
export function emailDomain(email?: string): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null
}

export interface TicketScope {
  mode: 'own' | 'org'   // 'org' → the customer sees all tickets in their domain
  domain: string | null
}

/**
 * Resolve how much this customer can see. Falls back to 'own' whenever there's no
 * configured org for their domain — so unknown/personal domains stay private.
 */
export async function resolveTicketScope(clientId: string, email?: string): Promise<TicketScope> {
  const domain = emailDomain(email)
  if (!domain) return { mode: 'own', domain: null }

  const [org] = await db.select().from(organizations)
    .where(and(eq(organizations.client_id, clientId), eq(organizations.domain, domain))).limit(1)
  if (!org) return { mode: 'own', domain }

  if (org.share_tickets) return { mode: 'org', domain }

  // Sharing off — but org admins still see everything for their domain.
  if (email) {
    const [admin] = await db.select().from(organizationAdmins)
      .where(and(eq(organizationAdmins.organization_id, org.id), eq(organizationAdmins.email, email.toLowerCase()))).limit(1)
    if (admin) return { mode: 'org', domain }
  }
  return { mode: 'own', domain }
}
