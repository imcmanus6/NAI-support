/** Central env access — fail fast on missing required config. */
import 'dotenv/config'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  briefly: {
    apiUrl: required('BRIEFLY_API_URL'),
    apiKey: required('BRIEFLY_API_KEY'),
  },
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  adminToken: process.env.ADMIN_TOKEN ?? '',   // gate for the operator admin API
  customerToken: {
    issuer: process.env.CUSTOMER_TOKEN_ISSUER ?? '',
    secret: process.env.CUSTOMER_TOKEN_SECRET ?? '',
  },
  port: Number(process.env.PORT ?? 4000),
}
