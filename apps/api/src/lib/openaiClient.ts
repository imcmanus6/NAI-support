import OpenAI from 'openai'
import { config } from './config.js'

/** The model used for the support agent. Cheap + fast by default; override via env. */
export const AGENT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

let client: OpenAI | null = null

/** Returns a shared OpenAI client, or null when no key is configured (dev fallback). */
export function getOpenAI(): OpenAI | null {
  if (!config.openaiApiKey) return null
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey })
  return client
}
