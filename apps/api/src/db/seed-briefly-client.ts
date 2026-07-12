/**
 * Seed the "Briefly" client and its space-role mapping — briefly as customer #1.
 *   npx tsx src/db/seed-briefly-client.ts
 *
 * Prereq: run `npm run db:push` first so the tables exist. The agent reaches these
 * spaces using BRIEFLY_API_KEY (from .env), which must be minted for the SAME hub
 * that owns these spaces (the "Briefly" hub, 03d431f7-…).
 *
 * Idempotent: reuses the client if present and replaces its space mapping.
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from './client.js'
import { clients, clientSpaces, softwareDbConnections } from './schema.js'

const CLIENT_NAME = 'Briefly'
const BRIEFLY_HUB_ID = '03d431f7-aec9-4686-bb75-74b6b0448d10'

// The three knowledge/ticket spaces created in the Briefly hub.
const MAPPING: { briefly_space_id: string; role: 'help' | 'internal' | 'tickets'; label: string }[] = [
  { briefly_space_id: '930d5fc2-36aa-4328-bd3d-e752b51629b3', role: 'help',     label: 'Help Center' },
  { briefly_space_id: 'fdb0c8c0-a9a3-49e0-a7c2-2dc3c386aada', role: 'internal', label: 'Internal Docs' },
  { briefly_space_id: '3637e63f-b702-46ee-94ab-1c9241bb3a79', role: 'tickets',  label: 'Support Tickets' },
]

async function main() {
  // client_key is what the host's identity token carries so we know it's this client.
  // token_secret / briefly_api_key are left null → the ENV values are used (single-tenant
  // dogfood). A real second/third host would set its own here instead of relying on env.
  let [client] = await db.select().from(clients).where(eq(clients.name, CLIENT_NAME)).limit(1)
  if (!client) {
    ;[client] = await db.insert(clients).values({
      name: CLIENT_NAME,
      client_key: 'briefly',
      briefly_hub_id: BRIEFLY_HUB_ID,
      ticket_destination: 'briefly',
    }).returning()
    console.log(`✅ created client "${CLIENT_NAME}" (${client.id})`)
  } else {
    await db.update(clients)
      .set({ client_key: 'briefly', briefly_hub_id: BRIEFLY_HUB_ID, ticket_destination: 'briefly', updated_at: new Date() })
      .where(eq(clients.id, client.id))
    console.log(`• client "${CLIENT_NAME}" exists (${client.id}) — refreshed`)
  }

  // Replace the space mapping wholesale.
  await db.delete(clientSpaces).where(eq(clientSpaces.client_id, client.id))
  await db.insert(clientSpaces).values(MAPPING.map(m => ({ client_id: client!.id, ...m })))
  for (const m of MAPPING) console.log(`   + ${m.role.padEnd(8)} → ${m.label} (${m.briefly_space_id})`)

  // Pre-fill the software-DB connection so "why can't I access X" works out of the box.
  // Reads Briefly's OWN DB: account from `users`, access (permissions) from `workspace_members`.
  // Set SOFTWARE_DB_URL to a READ-ONLY Briefly DB connection string (a replica is ideal).
  const softwareDbConfig = {
    url: process.env.SOFTWARE_DB_URL ?? 'postgres://REPLACE_ME_readonly@host:5432/briefly',
    account: {
      relation: 'users', customerKey: 'id',
      columns: { name: 'name', email: 'email' },
    },
    access: {
      relation: 'workspace_members', customerKey: 'user_id',
      columns: { resource: 'workspace_id', level: 'role' },
    },
  }
  const [existingDb] = await db.select().from(softwareDbConnections).where(eq(softwareDbConnections.client_id, client.id)).limit(1)
  if (existingDb) {
    await db.update(softwareDbConnections).set({ config_json: softwareDbConfig }).where(eq(softwareDbConnections.id, existingDb.id))
  } else {
    await db.insert(softwareDbConnections).values({ client_id: client.id, kind: 'postgres', config_json: softwareDbConfig })
  }
  console.log(`   + software-db: users(account) + workspace_members(access) — set SOFTWARE_DB_URL to a read-only Briefly DB`)

  console.log(`\nDone. Client id: ${client.id}`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
