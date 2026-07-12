/** Central env access — fail fast on missing required config. */
import 'dotenv/config'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  // Env Briefly creds are a FALLBACK — per-client credentials (clients table) take
  // precedence, so these aren't required at startup in a multi-tenant deployment.
  briefly: {
    apiUrl: process.env.BRIEFLY_API_URL ?? 'http://localhost:3001',
    apiKey: process.env.BRIEFLY_API_KEY ?? '',
  },
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  adminToken: process.env.ADMIN_TOKEN ?? '',   // gate for the operator admin API
  publicUrl: process.env.NAI_PUBLIC_URL ?? 'http://localhost:4000',  // for replay links
  customerToken: {
    issuer: process.env.CUSTOMER_TOKEN_ISSUER ?? '',
    secret: process.env.CUSTOMER_TOKEN_SECRET ?? '',
  },
  port: Number(process.env.PORT ?? 4000),
}
