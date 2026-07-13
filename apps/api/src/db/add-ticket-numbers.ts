/**
 * Add human-friendly ticket numbers.
 *   npx tsx src/db/add-ticket-numbers.ts
 *
 * Creates a global sequence (start #1001), adds tickets.number, and backfills existing
 * tickets in creation order. New tickets draw their number from the sequence at confirm.
 * Idempotent.
 */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { db } from './client.js'

async function main() {
  await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START 1001`)
  await db.execute(sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS number integer`)

  // Backfill existing tickets (oldest first) that don't have a number yet.
  const rows = await db.execute(sql`SELECT id FROM tickets WHERE number IS NULL ORDER BY created_at ASC`)
  let n = 0
  for (const r of rows as unknown as { id: string }[]) {
    const [{ next }] = await db.execute(sql`SELECT nextval('ticket_number_seq')::int AS next`) as unknown as { next: number }[]
    await db.execute(sql`UPDATE tickets SET number = ${next} WHERE id = ${r.id}`)
    n++
  }
  console.log(`✅ ticket numbers ready — backfilled ${n} existing ticket(s).`)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
