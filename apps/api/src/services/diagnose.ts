/**
 * AI auto-diagnosis. On ticket creation, reason over the evidence (conversation +
 * browser console/network capture + internal docs) and produce a root-cause
 * diagnosis, a category/severity, and whether the customer could self-resolve.
 * Attached to the ticket so a human starts from an answer, not a blank report —
 * and so fewer tickets need a human at all.
 */
import { getOpenAI, AGENT_MODEL } from '../lib/openaiClient.js'
import { formatDiagnosticsBlock, type Diagnostics } from '../lib/requestContext.js'

export type DiagCategory = 'bug' | 'feature_request' | 'question' | 'how_to'
export type DiagSeverity = 'low' | 'medium' | 'high'

export interface Diagnosis {
  summary: string                 // one-line root cause
  cause: string                   // short paragraph
  category: DiagCategory
  severity: DiagSeverity
  steps: string[]                 // suggested next steps
  customer_resolvable: boolean
}

export interface DiagnoseInput {
  title: string
  description: string
  transcript: string
  diagnostics?: Diagnostics
  internalContext?: string
  url?: string
}

const SYSTEM = `You are a senior engineer triaging a customer support ticket. Using the
customer's report, the conversation, the browser diagnostics (console errors + network
requests), and any internal engineering notes, produce a concise root-cause diagnosis.

Guidance:
- If a network request failed (4xx/5xx), that is almost always the cause — name the request.
- category: "bug" (something broken), "feature_request", "question", or "how_to".
- severity: "high" (broken / blocking / data loss), "medium", or "low".
- customer_resolvable: true ONLY if the customer can fix it themselves via the steps.
- Be specific and short. Never invent facts the evidence doesn't support; if unsure, say so.

Respond with ONLY a JSON object:
{"summary":"","cause":"","category":"bug","severity":"medium","steps":[""],"customer_resolvable":false}`

export async function diagnose(input: DiagnoseInput): Promise<Diagnosis | null> {
  const openai = getOpenAI()
  if (!openai) return null

  const user = [
    `Ticket: ${input.title}`,
    input.description ? `Detail: ${input.description}` : '',
    input.url ? `Page: ${input.url}` : '',
    `\nConversation:\n${input.transcript || '(none)'}`,
    input.diagnostics ? formatDiagnosticsBlock(input.diagnostics) : '',
    input.internalContext ? `\n\nInternal notes:\n${input.internalContext}` : '',
  ].filter(Boolean).join('\n')

  try {
    const completion = await openai.chat.completions.create({
      model: AGENT_MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    })
    const raw = completion.choices[0]?.message?.content
    if (!raw) return null
    const d = JSON.parse(raw) as Record<string, unknown>
    const cat = ['bug', 'feature_request', 'question', 'how_to']
    const sev = ['low', 'medium', 'high']
    return {
      summary: String(d.summary ?? '').slice(0, 500),
      cause: String(d.cause ?? '').slice(0, 2000),
      category: (cat.includes(d.category as string) ? d.category : 'question') as DiagCategory,
      severity: (sev.includes(d.severity as string) ? d.severity : 'medium') as DiagSeverity,
      steps: Array.isArray(d.steps) ? d.steps.map(s => String(s)).slice(0, 8) : [],
      customer_resolvable: !!d.customer_resolvable,
    }
  } catch {
    return null
  }
}

/** KPI-dashboard category (bug/feature/question/other) from the diagnosis category. */
export function kpiCategory(c: DiagCategory): string {
  return c === 'feature_request' ? 'feature' : c === 'how_to' ? 'question' : c
}

/** Human-readable diagnosis block for the ticket description. */
export function formatDiagnosisBlock(d: Diagnosis): string {
  const lines = [
    `\n\n— 🔍 AI diagnosis (${d.category} · ${d.severity})${d.customer_resolvable ? ' · likely self-resolvable' : ''} —`,
    d.summary,
  ]
  if (d.cause) lines.push('', d.cause)
  if (d.steps.length) lines.push('', 'Suggested next steps:', ...d.steps.map(s => `  • ${s}`))
  return lines.join('\n')
}
