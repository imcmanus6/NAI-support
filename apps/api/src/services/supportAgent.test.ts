/**
 * Exercises the tool-calling loop with a FAKE OpenAI client — no network, no DB.
 * Dummy env is set before the dynamic import so config.ts loads (it reads env at
 * module init; postgres/fetch are lazy and never actually connect here).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgres://x:x@localhost:5432/x'
process.env.BRIEFLY_API_URL ??= 'http://localhost:9'
process.env.BRIEFLY_API_KEY ??= 'bk_live_test'

const { runToolLoop, EXHAUSTED_REPLY } = await import('./supportAgent.js')

type Msg = { role: string; content?: string | null; tool_calls?: unknown[] }

/** Build a fake OpenAI whose create() returns each scripted assistant message in turn. */
function fakeOpenAI(script: Msg[]) {
  let i = 0
  const calls: unknown[][] = []
  const client = {
    chat: {
      completions: {
        create: async (params: { messages: unknown[] }) => {
          calls.push(params.messages)
          const message = script[Math.min(i, script.length - 1)]
          i += 1
          return { choices: [{ message }] }
        },
      },
    },
  }
  return { client, calls }
}

test('runToolLoop: returns final content when the model makes no tool calls', async () => {
  const { client } = fakeOpenAI([{ role: 'assistant', content: 'Hello, how can I help?' }])
  const execTool = async () => 'unused'
  const reply = await runToolLoop(client as never, [], execTool)
  assert.equal(reply, 'Hello, how can I help?')
})

test('runToolLoop: executes a tool call, feeds the result back, then returns the follow-up', async () => {
  const executed: { name: string; args: Record<string, unknown> }[] = []
  const script: Msg[] = [
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"refunds"}' } },
    ] },
    { role: 'assistant', content: 'Our refund window is 30 days.' },
  ]
  const { client, calls } = fakeOpenAI(script)
  const execTool = async (name: string, args: Record<string, unknown>) => {
    executed.push({ name, args })
    return JSON.stringify(['Refunds are accepted within 30 days.'])
  }

  const reply = await runToolLoop(client as never, [{ role: 'user', content: 'refund policy?' }], execTool)

  assert.equal(reply, 'Our refund window is 30 days.')
  assert.equal(executed.length, 1)
  assert.equal(executed[0].name, 'search_knowledge')
  assert.equal(executed[0].args.query, 'refunds')
  // Second model call must include the tool result message.
  const secondCallMessages = calls[1] as { role: string; content?: string }[]
  assert.ok(secondCallMessages.some(m => m.role === 'tool' && m.content?.includes('30 days')),
    'the tool result is fed back into the next completion')
})

test('runToolLoop: stops at the iteration budget when the model loops forever', async () => {
  // Model that always asks for another tool call.
  const alwaysToolCall: Msg = { role: 'assistant', content: null, tool_calls: [
    { id: 'c', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"x"}' } },
  ] }
  const { client } = fakeOpenAI([alwaysToolCall])
  let execCount = 0
  const execTool = async () => { execCount += 1; return '[]' }

  const reply = await runToolLoop(client as never, [], execTool, 3)
  assert.equal(reply, EXHAUSTED_REPLY)
  assert.equal(execCount, 3, 'stops after exactly maxIterations tool rounds')
})
