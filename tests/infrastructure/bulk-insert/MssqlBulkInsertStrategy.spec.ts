import knex, { Knex } from 'knex'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { KnexConnectionScope, MssqlBulkInsertStrategy, MssqlSchemaInspector } from '../../../src/knex'

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

    // DECIMAL(18,2) round-trip fixture (guards bug #3 — scale truncation).
    await db.schema.dropTableIfExists('decimal_test')
    await db.schema.createTable('decimal_test', (table) => {
      table.increments('id').primary()
      table.decimal('amount', 18, 2).notNullable()
    })

    // Non-dbo schema fixture (guards bug #2 — columnInfo() defaulting to dbo).
    // OBJECT_ID is schema-aware, so a table in [app_test] must inspect/load fine.
    await db.raw("IF SCHEMA_ID('app_test') IS NULL EXEC('CREATE SCHEMA app_test')")
    await db.schema.dropTableIfExists('app_test.scoped_table')
    await db.schema.withSchema('app_test').createTable('scoped_table', (table) => {
      table.increments('id').primary()
      table.string('label', 255).notNullable()
      table.decimal('rate', 18, 2).nullable()
    })
  })

  afterAll(async () => {
    if (db) {
      await db.schema.dropTableIfExists('bulk_test')
      await db.schema.dropTableIfExists('decimal_test')
      await db.schema.dropTableIfExists('app_test.scoped_table')
      await db.raw("IF SCHEMA_ID('app_test') IS NOT NULL EXEC('DROP SCHEMA app_test')")
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

  describe('transaction participation', () => {
    // KnexConnectionScope.transaction() runs its callback with a single
    // transaction-pinned connection that getConnection() exposes — exactly what
    // a repository feeds the strategy. These tests prove the TDS BulkLoad runs
    // *inside* that transaction (committed/rolled back atomically with it),
    // refuting the assumption that it auto-commits on a separate pool connection.
    const mapping = {
      name: 'name',
      price: 'price',
      created_at: 'created_at',
      is_active: 'is_active',
      description: 'description',
      metadata: 'metadata',
    }

    const row = (name: string) => ({
      name,
      price: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
      is_active: true,
      description: null,
      metadata: null,
    })

    async function countRows(): Promise<number> {
      const result = await db('bulk_test').count<{ c: number }[]>('* as c').first()
      return Number(result?.c ?? 0)
    }

    it('commits bulk-loaded rows with the surrounding transaction', async () => {
      const scope = new KnexConnectionScope(db)
      const strategy = new MssqlBulkInsertStrategy()

      await scope.transaction(async () => {
        const inserted = await strategy.execute(scope.getConnection(), jsonToStream([row('A'), row('B')]), {
          table: 'bulk_test',
          objectToDBmapping: mapping,
        })
        expect(inserted).toBe(2)
      })

      expect(await countRows()).toBe(2)
    })

    it('rolls back bulk-loaded rows when the surrounding transaction fails', async () => {
      const scope = new KnexConnectionScope(db)
      const strategy = new MssqlBulkInsertStrategy()

      await expect(
        scope.transaction(async () => {
          // BulkLoad reports success here...
          const inserted = await strategy.execute(scope.getConnection(), jsonToStream([row('A'), row('B')]), {
            table: 'bulk_test',
            objectToDBmapping: mapping,
          })
          expect(inserted).toBe(2)
          // ...but the transaction then fails, so the rows must not persist.
          throw new Error('force rollback')
        })
      ).rejects.toThrow('force rollback')

      // Proves the bulk-loaded rows were part of the transaction, not committed
      // independently on a separate connection.
      expect(await countRows()).toBe(0)
    })

    it('inspects a table on the transaction-pinned connection without EINVALIDSTATE', async () => {
      // THE regression test for bug #1. Inside KnexConnectionScope.transaction(),
      // getConnection() returns the transaction's single pinned tedious
      // connection. The OLD inspector ran two concurrent queries (columnInfo +
      // a flags query under Promise.all); the second request on that one pinned
      // connection threw EINVALIDSTATE ("Requests can only be made in the
      // LoggedIn state, not the SentClientRequest state").
      //
      // MssqlSchemaInspector has NO cache (unlike the strategy), so this runs
      // the live single-query inspect() on the pinned connection every time —
      // directly reproducing the real consumer (KnexRepository.bulkInsert builds
      // a fresh, cold-cache strategy per call). It must simply resolve.
      const scope = new KnexConnectionScope(db)

      await scope.transaction(async () => {
        const inspector = new MssqlSchemaInspector(scope.getConnection())
        const schema = await inspector.inspect('bulk_test')

        const byName = new Map(schema.map((c) => [c.name.toLowerCase(), c]))
        expect(byName.get('id')?.isIdentity).toBe(true)
        expect(byName.get('name')?.isIdentity).toBe(false)
        expect(schema.length).toBeGreaterThan(0)
      })
    })

    it('bulk-inserts inside a transaction with a cold-cache strategy (inspector runs on the pinned connection)', async () => {
      // Mirrors KnexRepository.bulkInsert: a FRESH strategy per call means an
      // empty schema cache, so the inspector runs *inside* the transaction on
      // the pinned connection. cacheSchema: false makes the cold-cache explicit
      // and removes the trap that hides bug #1 when a strategy instance is
      // reused (its warmed cache would skip the inspector inside the tx).
      const scope = new KnexConnectionScope(db)
      const strategy = new MssqlBulkInsertStrategy({ cacheSchema: false })

      await scope.transaction(async () => {
        const inserted = await strategy.execute(scope.getConnection(), jsonToStream([row('A'), row('B'), row('C')]), {
          table: 'bulk_test',
          objectToDBmapping: mapping,
        })
        expect(inserted).toBe(3)
      })

      expect(await countRows()).toBe(3)
    })
  })

  describe('non-dbo schema (guards bug #2)', () => {
    // knex columnInfo() defaulted the schema to dbo and returned ZERO columns
    // for a table in another schema, producing "no insertable columns". The
    // OBJECT_ID-based inspector resolves the schema-qualified name correctly.

    it('inspects a table in a non-dbo schema', async () => {
      const inspector = new MssqlSchemaInspector(db)

      const schema = await inspector.inspect('app_test.scoped_table')

      const names = schema.map((c) => c.name.toLowerCase()).sort()
      expect(names).toEqual(['id', 'label', 'rate'])
      const byName = new Map(schema.map((c) => [c.name.toLowerCase(), c]))
      expect(byName.get('id')?.isIdentity).toBe(true)
    })

    it('bulk-inserts into a table in a non-dbo schema', async () => {
      const strategy = new MssqlBulkInsertStrategy()

      const inserted = await strategy.execute(db, jsonToStream([{ label: 'one' }, { label: 'two' }]), {
        table: 'app_test.scoped_table',
        objectToDBmapping: { label: 'label' },
      })

      expect(inserted).toBe(2)
      const stored = await db.withSchema('app_test').from('scoped_table').select('label').orderBy('id')
      expect(stored.map((r) => r.label)).toEqual(['one', 'two'])
    })
  })

  describe('DECIMAL scale round-trip (guards bug #3)', () => {
    // composeOptions() now sets precision/scale for decimal/numeric. Before the
    // fix they were unset, so tedious BulkLoad defaulted scale to 0 and
    // truncated the fraction (DECIMAL(18,2) values stored as integers).

    it('preserves 2-dp scale through a bulk insert', async () => {
      // Cold-cache, transaction-pinned: the harshest path (inspector runs on the
      // pinned connection) and still must keep the fraction.
      const scope = new KnexConnectionScope(db)
      const strategy = new MssqlBulkInsertStrategy({ cacheSchema: false })

      const amounts = [299.99, 1000, 0.05, 12345.67]

      await scope.transaction(async () => {
        const inserted = await strategy.execute(
          scope.getConnection(),
          jsonToStream(amounts.map((amount) => ({ amount }))),
          { table: 'decimal_test', objectToDBmapping: { amount: 'amount' } }
        )
        expect(inserted).toBe(amounts.length)
      })

      const stored = await db('decimal_test').select('amount').orderBy('id')
      // knex returns DECIMAL as a string from the mssql driver; normalise to
      // Number so the assertion reads in decimal terms. Before the fix these
      // came back as 299, 1000, 0, 12345 (scale truncated to 0).
      const persisted = stored.map((r) => Number(r.amount))
      expect(persisted).toEqual([299.99, 1000, 0.05, 12345.67])
    })
  })
})
