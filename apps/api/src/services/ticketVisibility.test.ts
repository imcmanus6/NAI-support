import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgres://x:x@localhost:5432/x'
process.env.BRIEFLY_API_URL ??= 'http://localhost:9'
process.env.BRIEFLY_API_KEY ??= 'bk_live_test'

const { emailDomain } = await import('./ticketVisibility.js')

test('emailDomain: lowercases and extracts the domain', () => {
  assert.equal(emailDomain('Jane@Acme.com'), 'acme.com')
  assert.equal(emailDomain('a.b+tag@sub.example.co.uk'), 'sub.example.co.uk')
})

test('emailDomain: returns null for missing or malformed emails', () => {
  assert.equal(emailDomain(undefined), null)
  assert.equal(emailDomain(''), null)
  assert.equal(emailDomain('no-at-sign'), null)
})
