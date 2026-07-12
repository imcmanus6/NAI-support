# Integrating a host software with Support AI

Support AI is **multi-tenant**: one deployment serves many host softwares. Each host
is a `client`. Briefly is client #1; adding software #2 and #3 is the same four steps —
no code changes to Support AI.

Nothing here is briefly-specific. "Briefly as the knowledge/ticket backend" is a
*default*, swappable per client (a client can point at a different Briefly hub, and the
ticket destination is a per-client setting).

## The four steps to onboard a host

### 1. Knowledge + ticket backend
Give the client a place for knowledge and tickets. With the bundled Briefly backend:
- A **hub** with three spaces: one `help` (public), one `internal`, one `tickets`.
- A **Briefly API key** minted for that hub (`spaces:read, briefs:read, briefs:write`).

(For a non-Briefly backend, implement a new `TicketSink` + knowledge source — the
abstraction is already there; only the connector is new.)

### 2. Register the client in Support AI
Insert a `clients` row (see `apps/api/src/db/seed-briefly-client.ts` as the template):

| Field | Meaning |
|---|---|
| `name` | Display name |
| `client_key` | Public id the host puts in its token (e.g. `"acme"`) |
| `token_secret` | **Per-client** secret for verifying that host's identity tokens |
| `briefly_api_url` / `briefly_api_key` | This client's backend hub credentials |
| `ticket_destination` | `briefly` (or `jira` when wired) |

Then map its spaces (`client_spaces`): each space → role `help` / `internal` / `tickets`.

### 3. Mint identity tokens (in the host)
The host exposes an authenticated endpoint that returns a short-lived **HS256 JWT**
signed with the client's `token_secret`. Reference: Briefly's
`apps/api/src/routes/support.ts` + `lib/supportToken.ts`.

Required claims:
```json
{
  "sub": "<stable user id>",       // scopes all per-user data — REQUIRED
  "email": "user@host.com",         // optional, shown on tickets
  "name": "User Name",              // optional
  "client_key": "acme",             // REQUIRED — tells Support AI which client
  "iss": "acme",                    // optional issuer pin
  "iat": 1700000000,
  "exp": 1700000900                 // keep short (~15 min)
}
```
Signature: `HMAC-SHA256(base64url(header) + "." + base64url(payload), token_secret)`.

### 4. Embed the widget (in the host) — one script tag
Include the drop-in **loader** (served from the NAI widget origin, e.g.
`https://widget.nai.dev/loader.js`). It creates the launcher, mounts the iframe with the
token in the **URL hash** (never a query param, so it isn't logged), and records the host
page's console/network/errors for tickets.

**Bearer-JWT hosts** (e.g. Briefly) — provide a token hook:
```html
<script>window.NAI = { getToken: () => fetch('/api/support/token', {method:'POST', headers:{Authorization:'Bearer '+jwt}}).then(r=>r.json()).then(d=>d.token) }</script>
<script src="https://widget.nai.dev/loader.js"></script>
```
Briefly does this from React in `apps/web/src/components/support/SupportWidget.tsx`.

**Cookie-session hosts** — no hook needed, just point at the token endpoint:
```html
<script src="https://widget.nai.dev/loader.js" data-token-url="/api/support/token"></script>
```

The widget and loader are generic — same URLs for every host. The token decides which
client and user it is. Optional: `data-accent="#7c6cff"` to match the host's brand.

### 5. (The differentiator) Connect the host's live database
This is what a Jira/Confluence knowledge base *can't* do: answer "why can't **I** access X."
Give Support AI **read-only** access to the host's live DB — ideally a **read replica or a
copy**, never a write path — and it can look up the signed-in customer's real account,
orders, and **permissions/roles**.

Store it as a `software_db_connections` row (`config_json`) for the client. Map the
relations, always keyed by the customer id — including an `access` mapping for
permissions:
```json
{
  "url": "postgres://readonly@replica/app",
  "account": { "relation": "support_account_v", "customerKey": "user_id", "columns": { "plan": "plan", "status": "status" } },
  "access":  { "relation": "user_grants_v",     "customerKey": "user_id", "columns": { "resource": "resource", "level": "role" } }
}
```
Security is enforced in code, not by the LLM: every query is read-only, runs in a READ ONLY
transaction, binds `customerId` as `$1`, and only ever uses relations/columns from this
config (allowlist-validated). The agent gets narrow readers (`get_customer_account`,
`get_recent_orders`, `get_customer_access`) — never raw SQL, never another customer's id.

A client with no DB connection simply falls back to knowledge + tickets (the Jira/Confluence
level of capability). The DB connection is what unlocks user-specific support.

## What's shared vs per-client

- **Shared (one deployment):** the Support AI API, the agent, the widget, the software-DB
  connector framework.
- **Per-client (a `clients` row):** `client_key`, `token_secret`, backend credentials,
  space mapping, ticket destination, and (optionally) a software-DB connection.

## Security notes

- Each host has its **own** `token_secret` — a compromised host can't forge tokens for
  another. Support AI looks up the client by `client_key`, then verifies with *that*
  client's secret.
- `token_secret`, `briefly_api_key`, and software-DB creds are currently plaintext in the
  DB — **encrypt at rest before production.**
- In production, the widget host must allow framing: `Content-Security-Policy:
  frame-ancestors <host-origin>`.
