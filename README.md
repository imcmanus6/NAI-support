# Support AI

A standalone AI customer-support agent — a **separate product** from Briefly.

- Serves **external, untrusted end-customers** (of the products it supports).
- Reads a Briefly **hub's** knowledge (via Briefly's `/api/v1` key — no shared DB).
- Reads the **supported product's** database, **read-only and per-customer scoped**.
- Files **tickets** as Briefs back into Briefly (Jira later).

## Architecture

```
apps/api     Fastify + Drizzle + Postgres — its own DB, the agent loop, connectors
apps/admin   Vite + React — operator UI to set up clients and map Briefly spaces
```

### Trust boundaries (read before extending)

1. **Briefly** is reached only through `lib/brieflyClient.ts` using a hub-scoped API
   key. No shared database, no shared code.
2. **The supported product's DB** is reached only through `services/softwareDb.ts`,
   which exposes narrow, **per-customer-scoped** readers. The LLM never scopes
   customer data and never gets raw SQL — see the comment block in that file.
3. **End-customer identity** is verified in `lib/customerAuth.ts`. The verified
   `customerId` is the only thing allowed to scope software-DB queries.

### The client → space mapping

Each client (a customer of this AI service) maps to a few Briefly spaces —
typically **2 shared** (same for every client) + **1 specific**. That mapping lives
in *this* product's DB (`client_spaces`), not in Briefly. The operator sets it in
the admin UI, which lists the hub's spaces via `GET /admin/spaces`.

## Setup

```bash
cp .env.example .env          # fill DATABASE_URL, BRIEFLY_API_URL, BRIEFLY_API_KEY, OPENAI_API_KEY
npm install
npm run db:push -w apps/api   # create this product's tables
npm run dev                   # api on :4000, admin on :4001
```

Mint `BRIEFLY_API_KEY` in Briefly → Settings → Integrations → API keys (scopes:
`spaces:read`, `briefs:read`, `briefs:write`).

## What's a stub (wire these next)

- `services/supportAgent.ts` — the OpenAI tool-calling loop (tool impls are real & scoped; the model loop is a TODO).
- `services/softwareDb.ts` — connect to a real read-only role / read replica.
- `lib/customerAuth.ts` — replace decode-only with real signature + iss/aud/exp verification **before production**.
- Admin auth — the `/admin/*` routes are currently unauthenticated.
