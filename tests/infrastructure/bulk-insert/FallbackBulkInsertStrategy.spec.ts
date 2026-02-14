import knex, { Knex } from 'knex'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { FallbackBulkInsertStrategy } from '../../../src'

function jsonToStream<T>(arr: T[]): PassThrough & AsyncIterable<T> {
  const stream = new PassThrough({ objectMode: true })
  ;(stream as any)[Symbol.asyncIterator] = async function* () {
    for (const item of arr) {
      yield item
    }
  }
  arr.forEach((item) => stream.write(item))
  stream.end()
  return stream as PassThrough & AsyncIterable<T>
}

describe('FallbackBulkInsertStrategy', () => {
  let db: Knex

  beforeAll(async () => {
    db = knex({
      client: 'pg',
      connection: {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5433'),
        user: process.env.POSTGRES_USER || 'test_db',
        password: process.env.POSTGRES_PASSWORD || 'test_db',
        database: process.env.POSTGRES_DB || 'test_db',
      },
    })

    await db.schema.dropTableIfExists('fallback_test')
    await db.schema.createTable('fallback_test', (table) => {
      table.increments('id').primary()
      table.string('name').notNullable()
      table.float('price').notNullable()
    })
  })

  beforeEach(async () => {
    await db('fallback_test').truncate()
  })

  afterAll(async () => {
    // Don't drop the table here — it races with MikroORM schema introspection
    // in parallel test files. The beforeAll handles cleanup via dropTableIfExists.
    await db.destroy()
  })

  it('should insert items using standard INSERT', async () => {
    const strategy = new FallbackBulkInsertStrategy()
    const items = [
      { name: 'Item A', price: 10 },
      { name: 'Item B', price: 20 },
      { name: 'Item C', price: 30 },
    ]

    const count = await strategy.execute(db as any, jsonToStream(items), {
      table: 'fallback_test',
      objectToDBmapping: { name: 'name', price: 'price' },
    })

    expect(count).toBe(3)
    const rows = await db('fallback_test').select('*').orderBy('id')
    expect(rows).toHaveLength(3)
    expect(rows[0].name).toBe('Item A')
    expect(rows[2].price).toBe(30)
  })

  it('should batch inserts according to batchSize', async () => {
    const strategy = new FallbackBulkInsertStrategy(2)
    const items = [
      { name: 'A', price: 1 },
      { name: 'B', price: 2 },
      { name: 'C', price: 3 },
      { name: 'D', price: 4 },
      { name: 'E', price: 5 },
    ]

    const count = await strategy.execute(db as any, jsonToStream(items), {
      table: 'fallback_test',
      objectToDBmapping: { name: 'name', price: 'price' },
    })

    // 5 items with batchSize=2 → 2 full batches + 1 remainder
    expect(count).toBe(5)
    const rows = await db('fallback_test').select('*')
    expect(rows).toHaveLength(5)
  })

  it('should handle exact batch size boundary', async () => {
    const strategy = new FallbackBulkInsertStrategy(3)
    const items = [
      { name: 'A', price: 1 },
      { name: 'B', price: 2 },
      { name: 'C', price: 3 },
    ]

    const count = await strategy.execute(db as any, jsonToStream(items), {
      table: 'fallback_test',
      objectToDBmapping: { name: 'name', price: 'price' },
    })

    expect(count).toBe(3)
  })

  it('should return 0 for empty stream', async () => {
    const strategy = new FallbackBulkInsertStrategy()
    const count = await strategy.execute(db as any, jsonToStream([]), {
      table: 'fallback_test',
      objectToDBmapping: { name: 'name', price: 'price' },
    })

    expect(count).toBe(0)
  })

  it('should map object keys to DB columns', async () => {
    const strategy = new FallbackBulkInsertStrategy()
    const items = [{ productName: 'Mapped', productPrice: 99 }]

    const count = await strategy.execute(db as any, jsonToStream(items), {
      table: 'fallback_test',
      objectToDBmapping: { productName: 'name', productPrice: 'price' },
    })

    expect(count).toBe(1)
    const rows = await db('fallback_test').select('*')
    expect(rows[0].name).toBe('Mapped')
    expect(rows[0].price).toBe(99)
  })

})
