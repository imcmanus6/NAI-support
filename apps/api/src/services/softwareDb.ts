/**
 * Read-only connector to a supported product's database.
 *
 * The single most important security rule in this codebase lives here:
 *   THE LLM NEVER SCOPES CUSTOMER DATA — THIS CODE DOES.
 *
 * Every read takes a `customerId` that comes from the verified identity token
 * (customerAuth.ts), injected by the server and bound as `$1`. There is
 * deliberately no "run arbitrary SQL" or "fetch any customer" capability — the
 * agent gets narrow, parameterised readers and nothing else. A prompt-injected
 * agent still cannot reach another customer's rows.
 *
 * Each client's DB has its own schema, so the shape is described by OPERATOR
 * config (software_db_connections.config_json), validated by SoftwareDbConfig and
 * compiled to strictly-quoted parameterised queries in softwareDbQuery.ts.
 *
 * Defence in depth:
 *   - Point `url` at a READ-ONLY role (recommended: expose read-only VIEWS).
 *   - Every query also runs inside a READ ONLY transaction.
 *   - Identifiers from config are allowlist-validated before quoting.
 *
 * ⚠️ config_json currently stores the connection string in plaintext. Encrypt it
 * at rest before production (out of scope for this connector).
 */
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { softwareDbConnections } from '../db/schema.js'
import {
  SoftwareDbConfig, buildAccountQuery, buildOrdersQuery, buildAccessQuery,
  type CustomerAccount, type CustomerOrder, type CustomerAccess,
} from './softwareDbQuery.js'

export type { CustomerAccount, CustomerOrder, CustomerAccess } from './softwareDbQuery.js'

export interface SoftwareDbReader {
  getAccount(customerId: string): Promise<CustomerAccount | null>
  getRecentOrders(customerId: string, limit?: number): Promise<CustomerOrder[]>
  getAccess(customerId: string, limit?: number): Promise<CustomerAccess[]>
}

type Sql = ReturnType<typeof postgres>

// One connection pool per distinct external DB url, reused across turns.
const pools = new Map<string, Sql>()

function poolFor(url: string): Sql {
  let sql = pools.get(url)
  if (!sql) {
    // Small pool; connection-level read-only default as a belt to the per-query braces.
    sql = postgres(url, { max: 3, idle_timeout: 30, connection: { default_transaction_read_only: true } })
    pools.set(url, sql)
  }
  return sql
}

/** Run a parameterised query inside an explicit READ ONLY transaction. */
async function roQuery<T>(sql: Sql, text: string, params: unknown[]): Promise<T[]> {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION READ ONLY')
    return tx.unsafe(text, params as never[])
  }) as Promise<T[]>
}

/** Returns nothing — used when a client has no software DB configured. */
class NullSoftwareDbReader implements SoftwareDbReader {
  async getAccount(): Promise<CustomerAccount | null> { return null }
  async getRecentOrders(): Promise<CustomerOrder[]> { return [] }
  async getAccess(): Promise<CustomerAccess[]> { return [] }
}

class PostgresSoftwareDbReader implements SoftwareDbReader {
  constructor(private readonly sql: Sql, private readonly cfg: SoftwareDbConfig) {}

  async getAccount(customerId: string): Promise<CustomerAccount | null> {
    if (!this.cfg.account) return null
    const rows = await roQuery<CustomerAccount>(this.sql, buildAccountQuery(this.cfg.account), [customerId])
    return rows[0] ?? null
  }

  async getRecentOrders(customerId: string, limit = 10): Promise<CustomerOrder[]> {
    if (!this.cfg.orders) return []
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 100)
    return roQuery<CustomerOrder>(this.sql, buildOrdersQuery(this.cfg.orders), [customerId, safeLimit])
  }

  async getAccess(customerId: string, limit = 50): Promise<CustomerAccess[]> {
    if (!this.cfg.access) return []
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200)
    return roQuery<CustomerAccess>(this.sql, buildAccessQuery(this.cfg.access), [customerId, safeLimit])
  }
}

/**
 * Resolve the read-only reader for a client from its stored connection config.
 * Falls back to a NullReader when the client has no software DB configured.
 */
export async function getReaderForClient(clientId: string): Promise<SoftwareDbReader> {
  const [row] = await db
    .select()
    .from(softwareDbConnections)
    .where(eq(softwareDbConnections.client_id, clientId))
    .limit(1)
  if (!row) return new NullSoftwareDbReader()

  if (row.kind !== 'postgres') {
    throw new Error(`Unsupported software DB kind for client ${clientId}: ${row.kind}`)
  }
  const parsed = SoftwareDbConfig.safeParse(row.config_json)
  if (!parsed.success) {
    throw new Error(`Invalid software_db config for client ${clientId}: ${parsed.error.message}`)
  }
  return new PostgresSoftwareDbReader(poolFor(parsed.data.url), parsed.data)
}
