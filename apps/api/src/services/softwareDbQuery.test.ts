import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  quoteIdent, buildAccountQuery, buildOrdersQuery, buildAccessQuery, SoftwareDbConfig,
  type RelationMapping,
} from './softwareDbQuery.js'

const account: RelationMapping = {
  relation: 'support_account_v',
  customerKey: 'customer_id',
  columns: { id: 'id', plan: 'plan_name', status: 'status' },
}
const orders: RelationMapping = {
  relation: 'shop.support_orders_v',
  customerKey: 'customer_id',
  orderBy: 'placed_at',
  columns: { id: 'id', status: 'status', total: 'total_cents', placedAt: 'placed_at' },
}

test('buildAccountQuery: aliases columns, binds customerId as $1, never interpolates it', () => {
  const sql = buildAccountQuery(account)
  assert.equal(
    sql,
    'SELECT "id" AS "id", "plan_name" AS "plan", "status" AS "status" '
    + 'FROM "support_account_v" WHERE "customer_id" = $1 LIMIT 1',
  )
  assert.ok(sql.includes('$1'))
})

test('buildOrdersQuery: adds ORDER BY DESC and a bound LIMIT $2; quotes schema-qualified relation', () => {
  const sql = buildOrdersQuery(orders)
  assert.match(sql, /FROM "shop"\."support_orders_v"/)
  assert.match(sql, /WHERE "customer_id" = \$1 ORDER BY "placed_at" DESC LIMIT \$2$/)
})

test('buildAccessQuery: binds customerId as $1 and a LIMIT $2 for permissions lookup', () => {
  const sql = buildAccessQuery({
    relation: 'user_grants_v', customerKey: 'user_id',
    columns: { resource: 'resource', level: 'role' },
  })
  assert.match(sql, /SELECT "resource" AS "resource", "role" AS "level"/)
  assert.match(sql, /FROM "user_grants_v" WHERE "user_id" = \$1 LIMIT \$2$/)
})

test('quoteIdent: rejects injection attempts in identifiers', () => {
  for (const bad of [
    'id; DROP TABLE users',
    'id, secret_column',
    'a b',
    'a"b',
    "id' OR '1'='1",
    '1abc',
    '',
    'customer_id)--',
  ]) {
    assert.throws(() => quoteIdent(bad), /Invalid SQL identifier/, `should reject ${JSON.stringify(bad)}`)
  }
})

test('build*Query: a malicious relation/column in config is rejected, not emitted', () => {
  assert.throws(
    () => buildAccountQuery({ relation: 'orders; DROP TABLE x', customerKey: 'customer_id', columns: { id: 'id' } }),
    /Invalid SQL identifier/,
  )
  assert.throws(
    () => buildOrdersQuery({ relation: 'orders', customerKey: 'cid', columns: { id: 'id; select 1' } }),
    /Invalid SQL identifier/,
  )
})

test('SoftwareDbConfig: validates shape and requires at least one column', () => {
  assert.equal(SoftwareDbConfig.safeParse({ url: 'postgres://x', account }).success, true)
  assert.equal(SoftwareDbConfig.safeParse({ account }).success, false, 'url is required')
  assert.equal(
    SoftwareDbConfig.safeParse({ url: 'postgres://x', account: { relation: 'r', customerKey: 'c', columns: {} } }).success,
    false,
    'empty columns rejected',
  )
})
