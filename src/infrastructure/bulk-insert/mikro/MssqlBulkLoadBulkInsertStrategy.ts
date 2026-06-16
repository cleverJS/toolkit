import { Kysely } from 'kysely'
import { PassThrough, Transform } from 'stream'

import { peekAndReplayStream } from '../../../utils/helpers/streams'
import { IMssqlColumnDescriptor, IMssqlSchemaInspector } from '../knex/mssql/MssqlSchemaInspector'

import { IMikroBulkInsertContext, IMikroBulkInsertStrategy } from './IMikroBulkInsertStrategy'
import { KyselyChunkedBulkInsertStrategy } from './KyselyChunkedBulkInsertStrategy'
import { KyselyMssqlSchemaInspector } from './KyselyMssqlSchemaInspector'

/**
 * Structural subset of `tedious.BulkLoad`. Declared inline to keep `tedious`
 * an optional peer dependency at the type level.
 */
interface ITediousBulkLoad {
  setTimeout(ms: number): void
  addColumn(name: string, type: unknown, options: unknown): void
}

/**
 * Structural subset of `tedious.Connection`. The strategy only needs the
 * BulkLoad-related members.
 */
export interface ITediousConnection {
  newBulkLoad(table: string, options: unknown, callback: (err: Error | null | undefined, rowCount?: number) => void): ITediousBulkLoad
  execBulkLoad(bulkLoad: ITediousBulkLoad, rows: AsyncIterable<unknown> | Iterable<unknown>): void
  close?(): void
  state?: { name?: string }
}

/**
 * Caller-managed tedious connection source. The strategy invokes `acquire()` once
 * per BulkLoad and unconditionally invokes `release()` afterwards (passing the
 * original error if the BulkLoad failed) so the caller can decide whether to
 * return the connection to a pool, close it, or quarantine it.
 *
 * A simple "one connection per call" implementation is fine for typical use:
 * ```ts
 * import { Connection } from 'tedious'
 * const factory: ITediousConnectionFactory = {
 *   acquire: () => new Promise((resolve, reject) => {
 *     const conn = new Connection(config)
 *     conn.on('connect', err => err ? reject(err) : resolve(conn))
 *     conn.connect()
 *   }),
 *   release: (conn) => conn.close?.(),
 * }
 * ```
 */
export interface ITediousConnectionFactory {
  acquire(): Promise<ITediousConnection>
  release(conn: ITediousConnection, err?: unknown): void | Promise<void>
}

export interface IMssqlBulkLoadOptions {
  /** Source of tedious connections used for the BulkLoad call. */
  factory: ITediousConnectionFactory

  /**
   * Optional override for schema discovery. When omitted, the strategy uses
   * `KyselyMssqlSchemaInspector(ctx.kysely)` — i.e. introspection runs through
   * MikroORM's Kysely (same connection pool MikroORM uses for ORM queries).
   */
  inspector?: IMssqlSchemaInspector

  /** BulkLoad request timeout in ms. `0` (tedious default) inherits the connection's `requestTimeout`. */
  timeout?: number

  /** tedious BulkLoad behavior flags — see `Options` in `tedious/lib/bulk-load.d.ts`. */
  bulkOptions?: {
    checkConstraints?: boolean
    fireTriggers?: boolean
    keepNulls?: boolean
    lockTable?: boolean
    order?: Record<string, 'ASC' | 'DESC'>
  }

  /** Cache schemas across `execute()` calls. Default `true`. Disable when table DDL may change at runtime. */
  cacheSchema?: boolean

  /**
   * Inside a MikroORM transaction, BulkLoad cannot participate (the transaction's
   * connection is held by Kysely). When `true` (default), fall back to chunked
   * INSERT via the transactional Kysely. When `false`, throw.
   */
  fallbackInTransaction?: boolean

  /** Batch size for the in-transaction fallback path. Default 1000. */
  fallbackBatchSize?: number
}

/**
 * MSSQL streaming bulk insert via tedious' TDS `BulkLoad` (BCP) path.
 *
 * Why a separate code path from `MssqlBulkInsertStrategy`: the existing knex-based
 * strategy expects a `Knex.Client` to acquire a tedious connection. MikroORM v7
 * ships Kysely instead, and Kysely's MssqlDialect hides its tedious connections
 * behind hash-private fields. The Mikro variant therefore takes a caller-managed
 * `ITediousConnectionFactory` so the user controls connection lifecycle.
 *
 * Schema introspection (column types, identity/computed flags) goes through
 * MikroORM's Kysely (via `KyselyMssqlSchemaInspector`) so it shares the same
 * configured pool MikroORM uses. The BulkLoad itself runs on the factory's
 * connection, outside Kysely.
 *
 * Caveats (mirror those of `MssqlBulkInsertStrategy`):
 *   - Identity / computed columns are silently dropped from the payload.
 *   - On BulkLoad rejection the connection may be left mid-token-stream;
 *     `factory.release(conn, err)` should treat a non-null `err` as a signal
 *     to drop the connection rather than reuse it.
 */
export class MssqlBulkLoadBulkInsertStrategy implements IMikroBulkInsertStrategy {
  private readonly schemaCache = new Map<string, IMssqlColumnDescriptor[]>()
  private readonly cacheSchema: boolean
  private readonly fallback: KyselyChunkedBulkInsertStrategy
  private readonly fallbackInTransaction: boolean

  public constructor(private readonly options: IMssqlBulkLoadOptions) {
    this.cacheSchema = options.cacheSchema ?? true
    this.fallbackInTransaction = options.fallbackInTransaction ?? true
    this.fallback = new KyselyChunkedBulkInsertStrategy(options.fallbackBatchSize)
  }

  public async execute(ctx: IMikroBulkInsertContext): Promise<number> {
    if (ctx.isInTransaction) {
      if (!this.fallbackInTransaction) {
        throw new Error(
          'MssqlBulkLoadBulkInsertStrategy: BulkLoad cannot run inside a MikroORM transaction (Kysely owns the connection). ' +
            'Enable `fallbackInTransaction` (default) or invoke `bulkInsert` outside `scope.transaction()`.'
        )
      }
      return this.fallback.execute(ctx)
    }

    return this.#executeBulkLoad(ctx)
  }

  async #executeBulkLoad(ctx: IMikroBulkInsertContext): Promise<number> {
    const { table, stream, objectToDBmapping, kysely } = ctx

    // Empty stream: tedious BulkLoad rejects with "premature end-of-message", so peek
    // before acquiring a connection.
    let replayStream: PassThrough & AsyncIterable<Record<string, unknown>>
    try {
      const result = await peekAndReplayStream<Record<string, unknown>>(stream)
      replayStream = result.replayStream as PassThrough & AsyncIterable<Record<string, unknown>>
    } catch (err) {
      if (err instanceof Error && err.message === 'Stream is empty') {
        return 0
      }
      throw err
    }

    const schema = await this.#getSchema(kysely, table)
    const columnsToLoad = this.#selectColumnsForBulkLoad(schema, objectToDBmapping)

    if (columnsToLoad.length === 0) {
      throw new Error(
        `MssqlBulkLoadBulkInsertStrategy: no insertable columns resolved for table "${table}". Verify that objectToDBmapping references existing, non-identity, non-computed columns.`
      )
    }

    const connection = await this.options.factory.acquire()
    this.#assertConnectionUsable(connection)

    let bulkLoadError: unknown = null
    try {
      return await this.#runBulkLoad(connection, table, replayStream, columnsToLoad, objectToDBmapping)
    } catch (err) {
      bulkLoadError = err
      throw err
    } finally {
      // Hand the error back so the factory can poison/drop the connection rather
      // than return a possibly-broken socket to its pool.
      await this.options.factory.release(connection, bulkLoadError)
    }
  }

  async #getSchema(kysely: Kysely<any>, table: string): Promise<IMssqlColumnDescriptor[]> {
    const cacheKey = normaliseTableKey(table)

    if (this.cacheSchema) {
      const cached = this.schemaCache.get(cacheKey)
      if (cached) return cached
    }

    const inspector = this.options.inspector ?? new KyselyMssqlSchemaInspector(kysely)
    const schema = await inspector.inspect(table)

    if (this.cacheSchema) {
      this.schemaCache.set(cacheKey, schema)
    }
    return schema
  }

  #selectColumnsForBulkLoad(schema: IMssqlColumnDescriptor[], objectToDBmapping: Record<string, string>): IMssqlColumnDescriptor[] {
    const byLowerName = new Map(schema.map((c) => [c.name.toLowerCase(), c]))
    const wantedDbColumns = new Set(Object.values(objectToDBmapping))

    const missing: string[] = []
    const seen = new Set<string>()
    const result: IMssqlColumnDescriptor[] = []

    for (const dbColumn of wantedDbColumns) {
      const col = byLowerName.get(dbColumn.toLowerCase())
      if (!col) {
        missing.push(dbColumn)
        continue
      }
      if (col.isIdentity || col.isComputed) continue
      if (seen.has(col.name)) continue
      seen.add(col.name)
      result.push(col)
    }

    if (missing.length > 0) {
      throw new Error(`MssqlBulkLoadBulkInsertStrategy: columns not found in table schema: ${missing.join(', ')}`)
    }

    return result
  }

  #runBulkLoad(
    connection: ITediousConnection,
    table: string,
    stream: PassThrough & AsyncIterable<Record<string, unknown>>,
    columns: IMssqlColumnDescriptor[],
    objectToDBmapping: Record<string, string>
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let settled = false
      const rowStream = buildRowStream(stream, objectToDBmapping, columns)

      const settleReject = (err: unknown): void => {
        if (settled) return
        settled = true
        rowStream.destroy(err instanceof Error ? err : new Error(String(err)))
        if (typeof stream.destroy === 'function') {
          stream.destroy(err instanceof Error ? err : undefined)
        }
        reject(err as Error)
      }

      const settleResolve = (rowCount: number): void => {
        if (settled) return
        settled = true
        resolve(rowCount)
      }

      const bulkLoad = connection.newBulkLoad(table, this.options.bulkOptions ?? {}, (error, rowCount) => {
        if (error) {
          settleReject(error)
          return
        }
        settleResolve(rowCount ?? 0)
      })

      if (typeof this.options.timeout === 'number') {
        bulkLoad.setTimeout(this.options.timeout)
      }

      for (const col of columns) {
        bulkLoad.addColumn(col.name, col.type, col.options)
      }

      rowStream.on('error', (err) => settleReject(err))

      try {
        connection.execBulkLoad(bulkLoad, rowStream)
      } catch (err) {
        settleReject(err)
      }
    })
  }

  #assertConnectionUsable(connection: ITediousConnection): void {
    if (typeof connection.newBulkLoad !== 'function' || typeof connection.execBulkLoad !== 'function') {
      throw new Error('MssqlBulkLoadBulkInsertStrategy: factory.acquire() did not return a tedious-compatible connection.')
    }
    const stateName = connection.state?.name
    if (stateName && stateName !== 'LoggedIn') {
      throw new Error(`MssqlBulkLoadBulkInsertStrategy: tedious connection is not in LoggedIn state (actual: ${stateName}).`)
    }
  }
}

function normaliseTableKey(table: string): string {
  return table.toLowerCase().replace(/\[/g, '').replace(/\]/g, '').trim()
}

function buildRowStream(
  stream: PassThrough & AsyncIterable<Record<string, unknown>>,
  objectToDBmapping: Record<string, string>,
  columns: IMssqlColumnDescriptor[]
): PassThrough {
  // Build canonical (case-correct) lookup from "wanted DB column" → descriptor so emitted
  // row keys match what BulkLoad expects.
  const canonicalByLower = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]))
  const reverseMapping: Array<[string, string]> = []
  for (const [objKey, dbCol] of Object.entries(objectToDBmapping)) {
    const canonical = canonicalByLower.get(dbCol.toLowerCase())
    if (canonical) {
      reverseMapping.push([objKey, canonical])
    }
  }

  const transformer = new Transform({
    objectMode: true,
    transform(chunk: Record<string, unknown>, _enc, callback) {
      try {
        const row: Record<string, unknown> = {}
        for (const [objKey, dbCol] of reverseMapping) {
          if (!Object.prototype.hasOwnProperty.call(chunk, objKey)) {
            // eslint-disable-next-line security/detect-object-injection
            row[dbCol] = null
            continue
          }
          // eslint-disable-next-line security/detect-object-injection
          const value = chunk[objKey]
          // eslint-disable-next-line security/detect-object-injection
          row[dbCol] = serialiseValue(value)
        }
        callback(null, row)
      } catch (err) {
        callback(err as Error)
      }
    },
  })

  return stream.pipe(transformer)
}

function serialiseValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value
  // Binary payloads (VarBinary / Binary columns) pass through unchanged. JSON.stringify
  // on a Buffer would emit `{"type":"Buffer",...}`.
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value)) return value
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}
