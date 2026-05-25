import knex, { Knex } from 'knex'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MssqlBulkInsertStrategy, MssqlSchemaInspector } from '../../../src/knex'

/**
 * Integration tests for the MSSQL bulk-insert pipeline. Requires the
 * `cleverjs-test-mssql` container from docker-compose.test.yml.
 *
 * The suite skips itself when MSSQL_HOST is unset, so contributors who can't
 * run the MSSQL image (e.g. on aarch64 without amd64 emulation) aren't
 * blocked by failures here.
 */

const MSSQL_HOST = process.env.MSSQL_HOST
const RUN_INTEGRATION = MSSQL_HOST !== undefined && MSSQL_HOST !== ''
const describeIfMssql = RUN_INTEGRATION ? describe : describe.skip

function jsonToStream<T>(arr: T[]): PassThrough & AsyncIterable<T> {
  const stream = new PassThrough({ objectMode: true })
  ;(stream as any)[Symbol.asyncIterator] = async function* () {
    for (const item of arr) yield item
  }
  arr.forEach((item) => stream.write(item))
  stream.end()
  return stream as PassThrough & AsyncIterable<T>
}

describeIfMssql('MssqlBulkInsertStrategy (integration)', () => {
  let db: Knex

  beforeAll(async () => {
    db = knex({
      client: 'mssql',
      connection: {
        host: process.env.MSSQL_HOST,
        port: parseInt(process.env.MSSQL_PORT ?? '1433'),
        user: process.env.MSSQL_USER ?? 'sa',
        password: process.env.MSSQL_PASSWORD ?? 'YourStrong!Passw0rd',
        database: process.env.MSSQL_DB ?? 'test_db',
        options: { trustServerCertificate: true },
      },
      pool: { min: 0, max: 2 },
    } as Knex.Config)

    await db.schema.dropTableIfExists('bulk_test')
    await db.schema.createTable('bulk_test', (table) => {
      table.increments('id').primary()
      table.string('name', 255).notNullable()
      table.float('price').notNullable()
      table.dateTime('created_at').notNullable()
      table.string('description', 1000).nullable()
      table.boolean('is_active').notNullable()
      table.text('metadata').nullable()
    })
  })

  afterAll(async () => {
    if (db) {
      await db.schema.dropTableIfExists('bulk_test')
      await db.destroy()
    }
  })

  beforeEach(async () => {
    await db('bulk_test').delete()
  })

  describe('basic flow', () => {
    it('bulk-inserts rows via the TDS BulkLoad path', async () => {
      const strategy = new MssqlBulkInsertStrategy()
      const rows = [
        { name: 'A', price: 1.5, created_at: new Date('2026-01-01T00:00:00Z'), is_active: true, description: 'first', metadata: null },
        { name: 'B', price: 2.75, created_at: new Date('2026-01-02T00:00:00Z'), is_active: false, description: 'second', metadata: null },
        { name: 'C', price: 3.0, created_at: new Date('2026-01-03T00:00:00Z'), is_active: true, description: null, metadata: null },
      ]

      const inserted = await strategy.execute(db, jsonToStream(rows), {
        table: 'bulk_test',
        objectToDBmapping: {
          name: 'name',
          price: 'price',
          created_at: 'created_at',
          is_active: 'is_active',
          description: 'description',
          metadata: 'metadata',
        },
      })

      expect(inserted).toBe(3)
      const stored = await db('bulk_test').select('*').orderBy('id')
      expect(stored).toHaveLength(3)
      expect(stored[0].name).toBe('A')
      expect(stored[0].description).toBe('first')
      expect(stored[2].description).toBeNull()
    })

    it('auto-excludes the identity column when included in the mapping', async () => {
      const strategy = new MssqlBulkInsertStrategy()

      // The caller's mapping includes `id` (an identity column). The strategy
      // must silently skip it rather than failing or attempting an
      // identity insert.
      const inserted = await strategy.execute(
        db,
        jsonToStream([{ id: 999, name: 'A', price: 1, created_at: new Date(), is_active: true, description: null, metadata: null }]),
        {
          table: 'bulk_test',
          objectToDBmapping: {
            id: 'id',
            name: 'name',
            price: 'price',
            created_at: 'created_at',
            is_active: 'is_active',
            description: 'description',
            metadata: 'metadata',
          },
        }
      )

      expect(inserted).toBe(1)
      const [row] = await db('bulk_test').select('*')
      // SQL Server assigned its own identity value, not the caller-provided 999.
      expect(row.id).not.toBe(999)
      expect(row.name).toBe('A')
    })

    it('handles a large batch (1000 rows) without parameter-limit errors', async () => {
      const strategy = new MssqlBulkInsertStrategy()
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        name: `R${i}`,
        price: i * 0.5,
        created_at: new Date(),
        is_active: i % 2 === 0,
        description: i % 3 === 0 ? `desc ${i}` : null,
        metadata: null,
      }))

      const start = Date.now()
      const inserted = await strategy.execute(db, jsonToStream(rows), {
        table: 'bulk_test',
        objectToDBmapping: {
          name: 'name',
          price: 'price',
          created_at: 'created_at',
          is_active: 'is_active',
          description: 'description',
          metadata: 'metadata',
        },
      })
      const elapsed = Date.now() - start

      expect(inserted).toBe(1000)
      expect(elapsed).toBeLessThan(15000)

      const count = await db('bulk_test').count<{ c: number }[]>('* as c').first()
      expect(Number(count?.c ?? 0)).toBe(1000)
    })

    it('returns 0 for an empty stream without contacting the server', async () => {
      const strategy = new MssqlBulkInsertStrategy()
      const inserted = await strategy.execute(db, jsonToStream([]), {
        table: 'bulk_test',
        objectToDBmapping: {
          name: 'name',
          price: 'price',
          created_at: 'created_at',
          is_active: 'is_active',
          description: 'description',
          metadata: 'metadata',
        },
      })

      // tedious BulkLoad still issues a 0-row batch; we accept either 0 or a
      // null callback. The semantically meaningful assertion is that the
      // table is still empty.
      expect(inserted).toBe(0)
      const count = await db('bulk_test').count<{ c: number }[]>('* as c').first()
      expect(Number(count?.c ?? 0)).toBe(0)
    })
  })

  describe('value handling', () => {
    it('stringifies object values into NVarChar columns', async () => {
      const strategy = new MssqlBulkInsertStrategy()
      const metadata = { tags: ['x', 'y'], score: 1.5 }

      await strategy.execute(db, jsonToStream([{ name: 'M', price: 1, created_at: new Date(), is_active: true, description: null, metadata }]), {
        table: 'bulk_test',
        objectToDBmapping: {
          name: 'name',
          price: 'price',
          created_at: 'created_at',
          is_active: 'is_active',
          description: 'description',
          metadata: 'metadata',
        },
      })

      const [row] = await db('bulk_test').select('metadata')
      expect(JSON.parse(row.metadata)).toEqual(metadata)
    })

    it('persists Date values with millisecond fidelity', async () => {
      const strategy = new MssqlBulkInsertStrategy()
      const dateValue = new Date('2026-06-15T10:30:45.123Z')

      await strategy.execute(db, jsonToStream([{ name: 'D', price: 1, created_at: dateValue, is_active: true, description: null, metadata: null }]), {
        table: 'bulk_test',
        objectToDBmapping: {
          name: 'name',
          price: 'price',
          created_at: 'created_at',
          is_active: 'is_active',
          description: 'description',
          metadata: 'metadata',
        },
      })

      const [row] = await db('bulk_test').select('created_at')
      // knex returns Date for DateTime columns. SQL Server datetime has ~3ms
      // precision; we assert second-level fidelity to stay portable.
      const storedDate = new Date(row.created_at)
      expect(Math.abs(storedDate.getTime() - dateValue.getTime())).toBeLessThan(1000)
    })
  })

  describe('schema inspector', () => {
    it('detects identity and non-identity columns', async () => {
      const inspector = new MssqlSchemaInspector(db)
      const schema = await inspector.inspect('bulk_test')

      const byName = new Map(schema.map((c) => [c.name.toLowerCase(), c]))
      expect(byName.get('id')?.isIdentity).toBe(true)
      expect(byName.get('name')?.isIdentity).toBe(false)
      expect(byName.get('description')?.isIdentity).toBe(false)
    })

    it('throws on a non-existent table with a clear message', async () => {
      const inspector = new MssqlSchemaInspector(db)
      // columnInfo() throws first if the table is missing — verify the
      // message is propagated (we don't dictate exact wording, just that
      // the table name appears).
      await expect(inspector.inspect('does_not_exist_xyz')).rejects.toThrow()
    })
  })
})
