/**
 * The support product's OWN database. It deliberately stores what Briefly should
 * not know about: the AI-service's clients, which Briefly spaces feed each client
 * (the "2 shared + 1 specific" mapping), support conversations, and tickets.
 *
 * Briefly data is never copied here wholesale — it's read on demand via the
 * BrieflyClient (/api/v1). Only references (space ids, brief ids) are persisted.
 */
import { pgTable, uuid, text, timestamp, jsonb, pgEnum, boolean, unique, integer } from 'drizzle-orm/pg-core'

// How the agent may use a mapped space:
//   help     — public knowledge the agent may quote to customers
//   internal — engineers-only docs; NEVER shown to customers, only attached to tickets
//   tickets  — the space where ticket Briefs are filed
export const spaceRoleEnum = pgEnum('space_role', ['help', 'internal', 'tickets'])
export const messageRoleEnum = pgEnum('message_role', ['customer', 'agent', 'system'])
export const conversationStatusEnum = pgEnum('conversation_status', ['open', 'resolved', 'escalated'])
export const ticketStatusEnum = pgEnum('ticket_status', ['created', 'failed'])
// Where a client's tickets are filed. Only 'briefly' is wired today; 'jira' is a
// selectable setting whose sink is not yet implemented (see services/ticketSink.ts).
export const ticketDestinationEnum = pgEnum('ticket_destination', ['briefly', 'jira'])

// ── Clients: each customer of the AI-support service ──────────────────────────
export const clients = pgTable('clients', {
  id:              uuid('id').primaryKey().defaultRandom(),
  name:            text('name').notNull(),
  // Public identifier the host puts in its identity token so we know which client
  // it is (e.g. "briefly", "acme"). Each client is a separate host software.
  client_key:      text('client_key').unique(),
  // Per-client shared secret used to verify that host's identity tokens. Each host
  // has its own, so one host can't forge tokens for another. (Encrypt at rest before prod.)
  token_secret:    text('token_secret'),
  // The Briefly hub + credentials this client uses for knowledge + tickets. Per-client
  // so each host reads/writes its OWN hub. Fall back to env for the single-tenant case.
  briefly_hub_id:  text('briefly_hub_id'),
  briefly_api_url: text('briefly_api_url'),
  briefly_api_key: text('briefly_api_key'),
  // Public help-center link shown in the widget ("Browse the Help Center").
  help_url:        text('help_url'),
  // Where tickets for this client are filed.
  ticket_destination: ticketDestinationEnum('ticket_destination').notNull().default('briefly'),
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Client → Briefly space mapping (the 2-shared-plus-1-specific config) ──────
export const clientSpaces = pgTable('client_spaces', {
  id:               uuid('id').primaryKey().defaultRandom(),
  client_id:        uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  briefly_space_id: text('briefly_space_id').notNull(),   // references a space id in Briefly
  role:             spaceRoleEnum('role').notNull().default('help'),
  label:            text('label'),                        // cached space name for display
  created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Read-only connection config for the supported product's database ──────────
// The credentials should be encrypted at rest before production (see TODO in
// services/softwareDb.ts). Kept minimal here.
export const softwareDbConnections = pgTable('software_db_connections', {
  id:          uuid('id').primaryKey().defaultRandom(),
  client_id:   uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  kind:        text('kind').notNull().default('postgres'),
  config_json: jsonb('config_json').notNull().default({}),  // { url, ... } — encrypt before prod
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Organizations (JSM-style: customers grouped by email domain) ──────────────
// Operators create these deliberately, so personal domains (gmail, …) aren't grouped.
export const organizations = pgTable('organizations', {
  id:            uuid('id').primaryKey().defaultRandom(),
  client_id:     uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  domain:        text('domain').notNull(),                          // e.g. "acme.com"
  name:          text('name').notNull(),
  // When true, members of this org see each other's tickets.
  share_tickets: boolean('share_tickets').notNull().default(true),
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({ uniqDomain: unique().on(t.client_id, t.domain) }))

// Customer emails designated as admins of an org — they always see all the org's
// tickets, even when share_tickets is off.
export const organizationAdmins = pgTable('organization_admins', {
  id:              uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email:           text('email').notNull(),
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({ uniqEmail: unique().on(t.organization_id, t.email) }))

// ── Conversations & messages ──────────────────────────────────────────────────
export const conversations = pgTable('conversations', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  client_id:            uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  // Stable id of the end-customer, taken from their verified identity token.
  external_customer_id: text('external_customer_id').notNull(),
  // Captured from the identity token — used for org (domain) ticket visibility.
  customer_email:       text('customer_email'),
  customer_domain:      text('customer_domain'),
  status:               conversationStatusEnum('status').notNull().default('open'),
  // Captured session context (url, ip, location, browser, os, …) attached to tickets.
  context_json:         jsonb('context_json').notNull().default({}),
  created_at:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const messages = pgTable('messages', {
  id:              uuid('id').primaryKey().defaultRandom(),
  conversation_id: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role:            messageRoleEnum('role').notNull(),
  content:         text('content').notNull(),
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Session recordings (rrweb) — a reproducible capture attached to a ticket ──
export const recordings = pgTable('recordings', {
  id:              uuid('id').primaryKey().defaultRandom(),
  client_id:       uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  conversation_id: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  events_json:     jsonb('events_json').notNull(),         // rrweb event stream (replayable)
  meta_json:       jsonb('meta_json').notNull().default({}), // { url, duration_ms, events, browser }
  view_token:      text('view_token').notNull(),           // unguessable token for the replay link
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Tickets: briefs created back in Briefly (or, later, Jira) ─────────────────
export const tickets = pgTable('tickets', {
  id:              uuid('id').primaryKey().defaultRandom(),
  number:          integer('number'),                      // human-friendly ticket # (from ticket_number_seq)
  conversation_id: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  recording_id:    uuid('recording_id'),                   // optional rrweb replay
  destination:     ticketDestinationEnum('destination').notNull().default('briefly'),
  external_id:     text('external_id'),        // brief id (Briefly) or issue key (Jira)
  title:           text('title').notNull(),
  status:          ticketStatusEnum('status').notNull().default('created'),
  url:             text('url'),
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
