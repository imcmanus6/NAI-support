/**
 * Pure, DB-free query building for the software-DB connector. Split out so the
 * SQL-safety logic is unit-testable without a live external database.
 *
 * Security model: identifiers (relation/column/key names) come from OPERATOR
 * config — trusted, but we still validate them against a strict allowlist as
 * defence in depth. Customer VALUES are never interpolated — they're always
 * bound parameters ($1, $2). The LLM supplies neither.
 */
import { z } from 'zod'

export interface CustomerAccount {
  id: string
  plan: string
  status: string
  [key: string]: unknown
}

export interface CustomerOrder {
  id: string
  status: string
  total: number
  placedAt: string
  [key: string]: unknown
}

/** What this customer can access — roles, entitlements, resource grants. Shape is
 *  whatever the host maps (e.g. { resource, level, granted_at }). This is what lets
 *  the agent answer "why can't I access X" instead of just generic how-tos. */
export interface CustomerAccess {
  resource?: string
  level?: string
  [key: string]: unknown
}

/** How a client's DB exposes one entity: which relation, key column, and field→column map. */
export const RelationMapping = z.object({
  relation: z.string(),                       // table or (preferably) a read-only view; may be schema.qualified
  customerKey: z.string(),                     // the column filtered by the verified customer id
  orderBy: z.string().optional(),              // column for recency ordering (orders)
  columns: z.record(z.string()).refine(c => Object.keys(c).length > 0, 'at least one column mapping required'),
})
export type RelationMapping = z.infer<typeof RelationMapping>

export const SoftwareDbConfig = z.object({
  url: z.string().min(1),                      // read-only connection string to the client's DB (live or replica)
  account: RelationMapping.optional(),
  orders: RelationMapping.optional(),
  access: RelationMapping.optional(),          // the user's roles / entitlements / resource grants
})
export type SoftwareDbConfig = z.infer<typeof SoftwareDbConfig>

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validate + double-quote a single SQL identifier. Throws on anything suspicious. */
export function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`)
  return `"${name}"`
}

/** Quote a possibly schema-qualified relation, e.g. `public.orders`. */
export function quoteRelation(relation: string): string {
  return relation.split('.').map(quoteIdent).join('.')
}

/** `"db_col" AS "logicalField", ...` — validates every identifier. */
export function selectClause(columns: Record<string, string>): string {
  return Object.entries(columns)
    .map(([field, col]) => `${quoteIdent(col)} AS ${quoteIdent(field)}`)
    .join(', ')
}

/** SELECT one account row for a customer. `$1` = customerId. */
export function buildAccountQuery(m: RelationMapping): string {
  return `SELECT ${selectClause(m.columns)} FROM ${quoteRelation(m.relation)} `
    + `WHERE ${quoteIdent(m.customerKey)} = $1 LIMIT 1`
}

/** SELECT recent orders for a customer. `$1` = customerId, `$2` = limit. */
export function buildOrdersQuery(m: RelationMapping): string {
  const order = m.orderBy ? ` ORDER BY ${quoteIdent(m.orderBy)} DESC` : ''
  return `SELECT ${selectClause(m.columns)} FROM ${quoteRelation(m.relation)} `
    + `WHERE ${quoteIdent(m.customerKey)} = $1${order} LIMIT $2`
}

/** SELECT the customer's access rows (roles/entitlements). `$1` = customerId, `$2` = limit. */
export function buildAccessQuery(m: RelationMapping): string {
  const order = m.orderBy ? ` ORDER BY ${quoteIdent(m.orderBy)} DESC` : ''
  return `SELECT ${selectClause(m.columns)} FROM ${quoteRelation(m.relation)} `
    + `WHERE ${quoteIdent(m.customerKey)} = $1${order} LIMIT $2`
}
