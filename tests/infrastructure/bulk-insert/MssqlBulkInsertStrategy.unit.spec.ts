import { PassThrough } from 'stream'
import { TYPES } from 'tedious'
import { describe, expect, it, vi } from 'vitest'

import { IMssqlColumnDescriptor, IMssqlSchemaInspector, MssqlBulkInsertStrategy } from '../../../src'

/**
 * Pure-unit tests for MssqlBulkInsertStrategy: drive the strategy through a
 * stub IMssqlSchemaInspector and a fake knex client that returns a fake
 * tedious connection. Covers the column-selection, schema-cache, row-stream
 * transformation, and connection-poisoning paths without a real DB.
 *
 * Integration coverage (real BulkLoad against a running MSSQL instance) lives
 * in MssqlBulkInsertStrategy.spec.ts.
 */

function jsonToStream<T>(arr: T[]): PassThrough & AsyncIterable<T> {
  const stream = new PassThrough({ objectMode: true })
  ;(stream as any)[Symbol.asyncIterator] = async function* () {
    for (const item of arr) yield item
  }
  arr.forEach((item) => stream.write(item))
  stream.end()
  return stream as PassThrough & AsyncIterable<T>
}

interface IFakeConnectionOptions {
  newBulkLoadThrows?: Error
  execBulkLoadThrows?: Error
  bulkLoadCallbackError?: Error
  rowCount?: number
  closeImpl?: () => void
  state?: { name: string }
}

function createFakeKnexAndConnection(opts: IFakeConnectionOptions = {}) {
  const collectedRows: Record<string, any>[] = []
  let bulkLoadCallback: ((err: Error | null | undefined, rowCount?: number) => void) | null = null
  const columnsAdded: Array<{ name: string; type: unknown; options: unknown }> = []
  let timeoutSet: number | undefined

  const bulkLoad = {
    setTimeout: (ms: number) => {
      timeoutSet = ms
    },
    addColumn: (name: string, type: unknown, options: unknown) => {
      columnsAdded.push({ name, type, options })
    },
  }

  const connection: any = {
    state: opts.state ?? { name: 'LoggedIn' },
    newBulkLoad: vi.fn((_table: string, _options: unknown, cb: (err: Error | null | undefined, rowCount?: number) => void) => {
      if (opts.newBulkLoadThrows) throw opts.newBulkLoadThrows
      bulkLoadCallback = cb
      return bulkLoad
    }),
    execBulkLoad: vi.fn(async (_bl: unknown, rowStream: AsyncIterable<Record<string, any>>) => {
      if (opts.execBulkLoadThrows) throw opts.execBulkLoadThrows

      // Drain the rowStream so the test sees the same data tedious would.
      try {
        for await (const row of rowStream) {
          collectedRows.push(row)
        }
      } catch (err) {
        if (bulkLoadCallback) bulkLoadCallback(err as Error)
        return
      }

      if (bulkLoadCallback) {
        if (opts.bulkLoadCallbackError) bulkLoadCallback(opts.bulkLoadCallbackError)
        else bulkLoadCallback(null, opts.rowCount ?? collectedRows.length)
      }
    }),
    close: vi.fn(opts.closeImpl ?? (() => undefined)),
  }

  const client: any = {
    acquireConnection: vi.fn(async () => connection),
    releaseConnection: vi.fn(async () => undefined),
  }

  const knex: any = { client }

  return { knex, client, connection, getRows: () => collectedRows, getColumns: () => columnsAdded, getTimeout: () => timeoutSet }
}

function buildInspector(schema: IMssqlColumnDescriptor[]): IMssqlSchemaInspector {
  return {
    inspect: vi.fn(async () => schema),
  }
}

describe('MssqlBulkInsertStrategy (unit)', () => {
  describe('column selection', () => {
    it('drops identity and computed columns from objectToDBmapping', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'id', type: TYPES.Int, options: { nullable: false }, isIdentity: true, isComputed: false },
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
        { name: 'full_name', type: TYPES.NVarChar, options: { length: 510, nullable: true }, isIdentity: false, isComputed: true },
      ]
      const { knex, getColumns } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      const stream = jsonToStream([{ id: 1, name: 'Alice', full_name: 'Alice Smith' }])
      const inserted = await strategy.execute(knex, stream, {
        table: 'users',
        objectToDBmapping: { id: 'id', name: 'name', full_name: 'full_name' },
      })

      expect(inserted).toBe(1)
      const addedNames = getColumns().map((c) => c.name)
      expect(addedNames).toEqual(['name'])
    })

    it('throws when a mapped column is missing from the schema', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const { knex } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      const stream = jsonToStream([{ name: 'Alice', missing: 'x' }])

      await expect(strategy.execute(knex, stream, { table: 'users', objectToDBmapping: { name: 'name', missing: 'missing_col' } })).rejects.toThrow(
        /columns not found in table schema: missing_col/
      )
    })

    it('throws when every mapped column is identity/computed', async () => {
      const schema: IMssqlColumnDescriptor[] = [{ name: 'id', type: TYPES.Int, options: { nullable: false }, isIdentity: true, isComputed: false }]
      const { knex } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      const stream = jsonToStream([{ id: 1 }])

      await expect(strategy.execute(knex, stream, { table: 'users', objectToDBmapping: { id: 'id' } })).rejects.toThrow(
        /no insertable columns resolved/
      )
    })

    it('matches DB column names case-insensitively', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'UserName', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const { knex, getRows, getColumns } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      const stream = jsonToStream([{ userName: 'Alice' }])
      const inserted = await strategy.execute(knex, stream, { table: 'users', objectToDBmapping: { userName: 'username' } })

      expect(inserted).toBe(1)
      // BulkLoad must receive the canonical (schema-cased) column name.
      expect(getColumns()[0].name).toBe('UserName')
      expect(getRows()[0]).toEqual({ UserName: 'Alice' })
    })
  })

  describe('row stream transformation', () => {
    it('maps domain keys to DB column names and stringifies JSON values', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
        { name: 'metadata', type: TYPES.NVarChar, options: { length: Infinity, nullable: true }, isIdentity: false, isComputed: false },
      ]
      const { knex, getRows } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      const stream = jsonToStream([
        { displayName: 'Alice', meta: { tags: ['a', 'b'], score: 1.5 } },
        { displayName: 'Bob', meta: null },
      ])

      await strategy.execute(knex, stream, { table: 'users', objectToDBmapping: { displayName: 'name', meta: 'metadata' } })

      const rows = getRows()
      expect(rows).toEqual([
        { name: 'Alice', metadata: JSON.stringify({ tags: ['a', 'b'], score: 1.5 }) },
        { name: 'Bob', metadata: null },
      ])
    })

    it('passes Buffer and Date values through unchanged', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'payload', type: TYPES.VarBinary, options: { length: Infinity, nullable: true }, isIdentity: false, isComputed: false },
        { name: 'created_at', type: TYPES.DateTime2, options: { nullable: false }, isIdentity: false, isComputed: false },
      ]
      const { knex, getRows } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      const buf = Buffer.from([0x01, 0x02, 0x03])
      const date = new Date('2026-01-15T10:00:00.000Z')

      const stream = jsonToStream([{ payload: buf, created_at: date }])
      await strategy.execute(knex, stream, {
        table: 'blobs',
        objectToDBmapping: { payload: 'payload', created_at: 'created_at' },
      })

      const rows = getRows()
      expect(rows[0].payload).toBe(buf)
      expect(rows[0].created_at).toBe(date)
    })

    it('emits null for missing properties on a row', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
        { name: 'note', type: TYPES.NVarChar, options: { length: 255, nullable: true }, isIdentity: false, isComputed: false },
      ]
      const { knex, getRows } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      const stream = jsonToStream([{ name: 'Alice' }, { name: 'Bob', note: 'has note' }])
      await strategy.execute(knex, stream, { table: 'users', objectToDBmapping: { name: 'name', note: 'note' } })

      const rows = getRows()
      expect(rows[0]).toEqual({ name: 'Alice', note: null })
      expect(rows[1]).toEqual({ name: 'Bob', note: 'has note' })
    })

    it('coerces undefined to null', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'note', type: TYPES.NVarChar, options: { length: 255, nullable: true }, isIdentity: false, isComputed: false },
      ]
      const { knex, getRows } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      const stream = jsonToStream([{ note: undefined }])
      await strategy.execute(knex, stream, { table: 'users', objectToDBmapping: { note: 'note' } })

      expect(getRows()[0].note).toBeNull()
    })
  })

  describe('schema caching', () => {
    it('caches schema across calls when cacheSchema is true (default)', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const inspector = buildInspector(schema)
      const strategy = new MssqlBulkInsertStrategy({ inspector })

      const { knex: knex1 } = createFakeKnexAndConnection()
      const { knex: knex2 } = createFakeKnexAndConnection()

      await strategy.execute(knex1, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })
      await strategy.execute(knex2, jsonToStream([{ name: 'b' }]), { table: 'users', objectToDBmapping: { name: 'name' } })

      expect(inspector.inspect).toHaveBeenCalledTimes(1)
    })

    it('cache is case-insensitive on table name', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const inspector = buildInspector(schema)
      const strategy = new MssqlBulkInsertStrategy({ inspector })

      const { knex } = createFakeKnexAndConnection()

      await strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'Users', objectToDBmapping: { name: 'name' } })
      await strategy.execute(knex, jsonToStream([{ name: 'b' }]), { table: 'users', objectToDBmapping: { name: 'name' } })
      await strategy.execute(knex, jsonToStream([{ name: 'c' }]), { table: '[dbo].[Users]', objectToDBmapping: { name: 'name' } })

      // After normaliseTableKey: "Users"/"users" collapse to "users";
      // "[dbo].[Users]" normalises to "dbo.users" — a distinct key.
      expect(inspector.inspect).toHaveBeenCalledTimes(2)
    })

    it('re-inspects every call when cacheSchema is false', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const inspector = buildInspector(schema)
      const strategy = new MssqlBulkInsertStrategy({ inspector, cacheSchema: false })

      const { knex } = createFakeKnexAndConnection()
      await strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })
      await strategy.execute(knex, jsonToStream([{ name: 'b' }]), { table: 'users', objectToDBmapping: { name: 'name' } })

      expect(inspector.inspect).toHaveBeenCalledTimes(2)
    })
  })

  describe('connection lifecycle', () => {
    it('releases the connection on the success path', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const { knex, client, connection } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      await strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })

      expect(client.releaseConnection).toHaveBeenCalledWith(connection)
      expect(connection.close).not.toHaveBeenCalled()
    })

    it('closes and releases the connection when BulkLoad rejects', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const bulkErr = new Error('TDS error')
      const { knex, client, connection } = createFakeKnexAndConnection({ bulkLoadCallbackError: bulkErr })
      const onError = vi.fn()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema), onError })

      await expect(strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })).rejects.toBe(
        bulkErr
      )

      expect(onError).toHaveBeenCalledWith(connection, bulkErr)
      expect(connection.close).toHaveBeenCalled()
      expect(client.releaseConnection).toHaveBeenCalledWith(connection)
    })

    it('does not let an onError hook throw shadow the original error', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const bulkErr = new Error('TDS error')
      const { knex, connection } = createFakeKnexAndConnection({ bulkLoadCallbackError: bulkErr })
      const strategy = new MssqlBulkInsertStrategy({
        inspector: buildInspector(schema),
        onError: () => {
          throw new Error('hook explosion')
        },
      })

      await expect(strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })).rejects.toBe(
        bulkErr
      )

      // close() still ran despite the hook throwing.
      expect(connection.close).toHaveBeenCalled()
    })

    it('rejects when the connection is not in LoggedIn state', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const { knex, client } = createFakeKnexAndConnection({ state: { name: 'Final' } })
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      await expect(strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })).rejects.toThrow(
        /not in LoggedIn state/
      )
      expect(client.releaseConnection).toHaveBeenCalled()
    })

    it('rejects when the knex client returns a non-tedious connection', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const knex: any = {
        client: {
          acquireConnection: vi.fn(async () => ({ state: { name: 'LoggedIn' } /* no newBulkLoad */ })),
          releaseConnection: vi.fn(async () => undefined),
        },
      }
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema) })

      await expect(strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })).rejects.toThrow(
        /knex client did not return a tedious-compatible connection/
      )
      expect(knex.client.releaseConnection).toHaveBeenCalled()
    })
  })

  describe('options forwarding', () => {
    it('applies a configured timeout to the BulkLoad', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const { knex, getTimeout } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({ inspector: buildInspector(schema), timeout: 12345 })

      await strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })

      expect(getTimeout()).toBe(12345)
    })

    it('forwards bulkOptions to tedious.newBulkLoad', async () => {
      const schema: IMssqlColumnDescriptor[] = [
        { name: 'name', type: TYPES.NVarChar, options: { length: 255, nullable: false }, isIdentity: false, isComputed: false },
      ]
      const { knex, connection } = createFakeKnexAndConnection()
      const strategy = new MssqlBulkInsertStrategy({
        inspector: buildInspector(schema),
        bulkOptions: { checkConstraints: true, fireTriggers: true, keepNulls: true, lockTable: true },
      })

      await strategy.execute(knex, jsonToStream([{ name: 'a' }]), { table: 'users', objectToDBmapping: { name: 'name' } })

      expect(connection.newBulkLoad).toHaveBeenCalledWith(
        'users',
        { checkConstraints: true, fireTriggers: true, keepNulls: true, lockTable: true },
        expect.any(Function)
      )
    })
  })
})
