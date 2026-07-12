import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyRequest } from 'fastify'
import { parseUserAgent, clientIp, formatContextBlock } from './requestContext.js'

test('parseUserAgent: identifies common browsers and OSes', () => {
  const chromeMac = parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36')
  assert.equal(chromeMac.browser, 'Chrome 124')
  assert.equal(chromeMac.os, 'macOS')

  const edgeWin = parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124.0')
  assert.equal(edgeWin.browser, 'Edge 124')   // Edge must win over the Chrome token it also contains
  assert.equal(edgeWin.os, 'Windows 10/11')

  const safariIos = parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')
  assert.equal(safariIos.browser, 'Safari 17')
  assert.equal(safariIos.os, 'iOS')

  assert.deepEqual(parseUserAgent(undefined), {})
})

test('clientIp: prefers the first X-Forwarded-For hop', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, ip: '10.0.0.1' } as unknown as FastifyRequest
  assert.equal(clientIp(req), '203.0.113.9')

  const direct = { headers: {}, ip: '198.51.100.4' } as unknown as FastifyRequest
  assert.equal(clientIp(direct), '198.51.100.4')
})

test('formatContextBlock: renders only the fields present', () => {
  const block = formatContextBlock({
    url: 'https://app.example.com/orders/42',
    browser: 'Chrome 124', os: 'macOS',
    ipAddress: '203.0.113.9', location: '~America/New_York',
    language: 'en-US', screen: '1512x982', timezone: 'America/New_York',
    attachment: { name: 'bug.png', type: 'image/png', size: 20481 },
  })
  assert.match(block, /— Session context —/)
  assert.match(block, /Page: https:\/\/app\.example\.com\/orders\/42/)
  assert.match(block, /Browser: Chrome 124 on macOS/)
  assert.match(block, /IP 203\.0\.113\.9 · Location ~America\/New_York/)
  assert.match(block, /Attachment: bug\.png \(image\/png, 20481 bytes\)/)

  assert.equal(formatContextBlock({}), '', 'empty context yields no block')
})
