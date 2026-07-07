import { AdapterType, ConditionAdapterRegistry, KnexConditionAdapter } from '@cleverjs/condition-builder'
import knex, { Knex } from 'knex'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { IdentityMapper } from '../../../src'
import { FallbackBulkInsertStrategy, KnexConnectionScope, KnexRepository, PostgresBulkInsertStrategy } from '../../../src/knex'

interface Row {
  id: number
  txt: string | null
  meta?: Record<string, unknown> | null
}

function jsonToStream<T>(arr: T[]): PassThrough & AsyncIterable<T> {
  const stream = new PassThrough({ objectMode: true })
  arr.forEach((item) => stream.write(item))
  stream.end()
  return stream as PassThrough & AsyncIterable<T>
}

/** Emits `items`, then destroys the stream with `error` (mid-flow failure of the producer). */
function erroringStream<T>(items: T[], error: Error): PassThrough & AsyncIterable<T> {
  const stream = new PassThrough({ objectMode: true })
  items.forEach((item) => stream.write(item))
  setImmediate(() => stream.destroy(error))
  return stream as PassThrough & AsyncIterable<T>
}

// Regression suite for stream error propagation (manual .pipe() chains used to
// leave source errors unhandled — crashing the process — or hang the caller)
// and for COPY CSV empty-string handling ('' used to arrive as NULL).
describe('bulk insert stream error propagation (regression)', () => {
  let db: Knex
  let scope: KnexConnectionScope
  let repository: KnexRepository<Row, Row>
  let conditionRegistry: ConditionAdapterRegistry

  beforeAll(async () => {
    conditionRegistry = new ConditionAdapterRegistry()
    conditionRegistry.register(AdapterType.KNEX, new KnexConditionAdapter())

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

    await db.schema.dropTableIfExists('test_stream_err')
    await db.schema.createTable('test_stream_err', (table) => {
      table.integer('id').primary()
      table.text('txt').nullable()
      table.jsonb('meta').nullable()
    })

    scope = new KnexConnectionScope(db)
    repository = new KnexRepository<Row, Row>(scope, new IdentityMapper<Row>(), {
      table: 'test_stream_err',
      primary: ['id'],
      conditionRegistry,
    })
  })

  afterAll(async () => {
    await db.schema.dropTableIfExists('test_stream_err')
    await db.destroy()
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE TABLE ?? CASCADE', ['test_stream_err'])
  })

  describe('bulkInsert (COPY path — PostgresBulkInsertStrategy)', () => {
    it('should reject (not crash) when the source stream errors mid-flow', async () => {
      const stream = erroringStream<Row>(
        [
          { id: 1, txt: 'a' },
          { id: 2, txt: 'b' },
        ],
        new Error('db connection lost')
      )

      await expect(repository.bulkInsert(stream)).rejects.toThrow('db connection lost')

      // COPY aborted: nothing committed, and the pool connection was released.
      expect(await repository.count()).toBe(0)
    })

    it('should reject (not crash or hang) when a row fails CSV serialization', async () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular

      const stream = jsonToStream<Row>([
        { id: 1, txt: 'ok', meta: { ok: true } },
        { id: 2, txt: 'bad', meta: circular },
      ])

      await expect(repository.bulkInsert(stream)).rejects.toThrow(/circular/i)

      // The connection must be released back to the pool despite the failure.
      expect(await repository.count()).toBe(0)
    })

    it('should keep empty strings as empty strings, not NULL', async () => {
      const stream = jsonToStream<Row>([
        { id: 1, txt: '' },
        { id: 2, txt: 'hello' },
        { id: 3, txt: null },
      ])

      const inserted = await repository.bulkInsert(stream)
      expect(inserted).toBe(3)

      const rows = await db('test_stream_err').select('id', 'txt').orderBy('id')
      expect(rows).toEqual([
        { id: 1, txt: '' },
        { id: 2, txt: 'hello' },
        { id: 3, txt: null },
      ])
    })
  })

  describe('bulkInsert (FallbackBulkInsertStrategy)', () => {
    it('should reject (not crash) when the source stream errors mid-flow', async () => {
      const fallbackRepository = new KnexRepository<Row, Row>(scope, new IdentityMapper<Row>(), {
        table: 'test_stream_err',
        primary: ['id'],
        conditionRegistry,
        bulkInsertStrategy: new FallbackBulkInsertStrategy(),
      })

      const stream = erroringStream<Row>([{ id: 1, txt: 'a' }], new Error('producer failed'))

      await expect(fallbackRepository.bulkInsert(stream)).rejects.toThrow('producer failed')
    })
  })

  describe('bulkInsert (explicit PostgresBulkInsertStrategy instance)', () => {
    it('should reject when the source errors while the strategy is invoked directly', async () => {
      const strategy = new PostgresBulkInsertStrategy()
      const stream = erroringStream<Row>([{ id: 1, txt: 'a' }], new Error('direct source failure'))

      await expect(strategy.execute(db, stream, { table: 'test_stream_err', objectToDBmapping: { id: 'id', txt: 'txt' } })).rejects.toThrow(
        'direct source failure'
      )

      // Pool must still serve queries after the failed COPY.
      const result = await db.raw<{ rows: Array<{ ok: number }> }>('SELECT 1 AS ok')
      expect(result.rows[0].ok).toBe(1)
    })
  })

  describe('stream() read path', () => {
    it('should reject async iteration (not crash) when the query stream errors', async () => {
      const missingTableRepository = new KnexRepository<Row, Row>(scope, new IdentityMapper<Row>(), {
        table: 'test_stream_err_missing',
        primary: ['id'],
        conditionRegistry,
      })

      const consume = (async () => {
        const rows: Row[] = []
        for await (const row of missingTableRepository.stream<Row>({})) {
          rows.push(row)
        }
        return rows
      })()

      await expect(consume).rejects.toThrow(/test_stream_err_missing/)
    })
  })
})
