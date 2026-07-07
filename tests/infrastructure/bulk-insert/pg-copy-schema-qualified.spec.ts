import { AdapterType, ConditionAdapterRegistry, KnexConditionAdapter } from '@cleverjs/condition-builder'
import knex, { Knex } from 'knex'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { IdentityMapper } from '../../../src'
import { KnexConnectionScope, KnexRepository, PostgresBulkInsertStrategy } from '../../../src/knex'

interface Row {
  id: number
  txt: string
}

const SCHEMA = 'bulk_copy_test'
const TABLE = `${SCHEMA}.items`

function jsonToStream<T>(arr: T[]): PassThrough & AsyncIterable<T> {
  const stream = new PassThrough({ objectMode: true })
  arr.forEach((item) => stream.write(item))
  stream.end()
  return stream as PassThrough & AsyncIterable<T>
}

// Regression: a schema-qualified table used to be escaped as a single
// identifier ("bulk_copy_test.items"), so COPY targeted a relation of that
// literal name in the search_path and failed with "relation does not exist".
describe('PostgresBulkInsertStrategy — schema-qualified table (regression)', () => {
  let db: Knex
  let repository: KnexRepository<Row, Row>

  beforeAll(async () => {
    db = knex({
      client: 'pg',
      connection: {
        host: process.env.POSTGRES_HOST || '127.0.0.1',
        port: parseInt(process.env.POSTGRES_PORT || '5433'),
        user: process.env.POSTGRES_USER || 'test_db',
        password: process.env.POSTGRES_PASSWORD || 'test_db',
        database: process.env.POSTGRES_DB || 'test_db',
      },
    })

    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [SCHEMA])
    await db.raw('CREATE SCHEMA ??', [SCHEMA])
    await db.schema.withSchema(SCHEMA).createTable('items', (table) => {
      table.integer('id').primary()
      table.text('txt').notNullable()
    })

    const conditionRegistry = new ConditionAdapterRegistry()
    conditionRegistry.register(AdapterType.KNEX, new KnexConditionAdapter())

    const scope = new KnexConnectionScope(db)
    repository = new KnexRepository<Row, Row>(scope, new IdentityMapper<Row>(), {
      table: TABLE,
      primary: ['id'],
      conditionRegistry,
      bulkInsertStrategy: new PostgresBulkInsertStrategy(),
    })
  })

  afterAll(async () => {
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [SCHEMA])
    await db.destroy()
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE TABLE ?? CASCADE', [TABLE])
  })

  it('COPY-inserts rows into the correct non-default schema', async () => {
    const inserted = await repository.bulkInsert(
      jsonToStream<Row>([
        { id: 1, txt: 'a' },
        { id: 2, txt: 'b' },
      ])
    )
    expect(inserted).toBe(2)

    const rows = await db.withSchema(SCHEMA).from('items').select('id', 'txt').orderBy('id')
    expect(rows).toEqual([
      { id: 1, txt: 'a' },
      { id: 2, txt: 'b' },
    ])
  })
})
