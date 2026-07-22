import { sql } from 'drizzle-orm'
import { db } from './client.js'

/**
 * Idempotent raw-DDL that `drizzle-kit push` doesn't manage (Postgres sequences,
 * etc.). Runs on every API boot so a fresh deploy / new environment can never
 * be missing it. Safe to run repeatedly.
 *
 * History: `ticket_number_seq` was created only by a one-off script that never
 * ran in production, so every ticket-confirm hit `nextval` on a non-existent
 * sequence (42P01) and 500'd before filing. Ensuring it here prevents a repeat.
 */
export async function ensureSchema(): Promise<void> {
  // Human-friendly ticket numbers start at #1001; confirm draws nextval().
  await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START 1001`)
}
