import { Knex } from 'knex'
import { PassThrough, Transform } from 'stream'

import { peekAndReplayStream } from '../../../utils/helpers/streams'
import { IBulkInsertOptions, IBulkInsertStrategy } from '../IBulkInsertStrategy'

import { IMssqlColumnDescriptor, IMssqlSchemaInspector, MssqlSchemaInspector } from './mssql/MssqlSchemaInspector'

export interface IMssqlBulkInsertStrategyOptions {
  /**
   * BulkLoad request timeout in ms. `0` (tedious default) falls back to the
   * connection's `requestTimeout`.
   */
  timeout?: number

  /**
   * tedious BulkLoad behavior flags — see `Options` in `tedious/lib/bulk-load.d.ts`.
   */
  bulkOptions?: {
    checkConstraints?: boolean
    fireTriggers?: boolean
    keepNulls?: boolean
    lockTable?: boolean
    order?: Record<string, 'ASC' | 'DESC'>
  }

  /**
   * Override schema discovery. Useful for tests and for callers that want to
   * provide a hand-rolled schema instead of relying on `sys.columns`.
   */
  inspector?: IMssqlSchemaInspector

  /**
   * Cache schemas across `execute()` calls. Defaults to `true`. Disable when
   * the underlying table DDL may change at runtime.
   */
  cacheSchema?: boolean

  /**
   * Invoked when BulkLoad rejects, before the tedious connection is closed
   * and released. Use this to plug in app-specific "poison" tracking so the
   * pool doesn't hand the now-broken connection back to the next caller.
   *
   * Not invoked when the BulkLoad runs on a connection pinned to a
   * `KnexConnectionScope` transaction: that connection is owned by the
   * transaction and is neither closed nor poisoned (its rollback handles it).
   */
  onError?: (connection: unknown, err: unknown) => void
}

interface IRunBulkLoadArgs<T> {
  connection: ITediousConnection
  table: string
  stream: PassThrough & AsyncIterable<T>
  columns: IMssqlColumnDescriptor[]
  objectToDBmapping: Record<string, string>
}

interface ITediousBulkLoad {
  setTimeout(ms: number): void
  addColumn(name: string, type: unknown, options: unknown): void
}

interface ITediousConnection {
  newBulkLoad(table: string, options: unknown, callback: (err: Error | null | undefined, rowCount?: number) => void): ITediousBulkLoad
  execBulkLoad(bulkLoad: ITediousBulkLoad, rows: AsyncIterable<unknown> | Iterable<unknown>): void
  close?(): void
  state?: { name?: string }
}

/**
 * MSSQL bulk insert via tedious' TDS BulkLoad (BCP) path. Materially faster
 * than knex's `batchInsert` (which hits the 2100-parameter TDS limit and
 * issues one INSERT per batch).
 *
 * The strategy:
 *   1. Acquires a raw `tedious.Connection` from the knex pool.
 *   2. Discovers the column schema (`columnInfo()` + `sys.columns` for
 *      identity / computed flags) and caches it per-table (case-insensitive).
 *   3. Builds a `BulkLoad` with one `addColumn(...)` per non-identity,
 *      non-computed column referenced in `objectToDBmapping`.
 *   4. Streams rows through a Transform that maps domain keys -> DB keys
 *      and stringifies plain-object values (MSSQL has no native JSON type).
 *   5. Calls `connection.execBulkLoad(bulkLoad, asyncIterable)` — tedious 9+
 *      accepts `AsyncIterable<Record>` for streaming.
 *
 * BulkLoad is atomic at the TDS layer, so the strategy does NOT wrap the
 * call in an explicit `BEGIN/COMMIT` — that would only add a round-trip
 * without changing semantics.
 *
 * Transactions: when invoked through a repository running inside a
 * `KnexConnectionScope` transaction, knex hands the strategy the transaction's
 * pinned connection (its `acquireConnection()` returns that single connection
 * and `releaseConnection()` is a no-op). The BulkLoad therefore runs on the
 * transaction's own connection/session and is committed or rolled back atomically
 * with the rest of the transaction.
 *
 * Caveat: when BulkLoad rejects, the tedious connection may be left in an
 * indeterminate TDS state (mid-token-stream on socket reset). To avoid
 * handing a poisoned connection back to the pool, the strategy closes the
 * connection on error before releasing it; the pool's validator then drops
 * the closed entry on next acquire. The one exception is the transaction-pinned
 * connection above: it belongs to the surrounding transaction, so the strategy
 * leaves it open on error and lets the transaction's rollback clean up — closing
 * it would tear down the transaction's connection and break knex's own rollback.
 */
export class MssqlBulkInsertStrategy implements IBulkInsertStrategy<Knex> {
  private readonly schemaCache = new Map<string, IMssqlColumnDescriptor[]>()
  private readonly cacheSchema: boolean

  public constructor(private readonly options: IMssqlBulkInsertStrategyOptions = {}) {
    this.cacheSchema = options.cacheSchema ?? true
  }

  public async execute<T>(knex: Knex, stream: PassThrough & AsyncIterable<T>, opts: IBulkInsertOptions): Promise<number> {
    const { table, objectToDBmapping } = opts

    // tedious BulkLoad rejects an empty payload with "premature end-of-message"
    // — peek the first row to short-circuit before acquiring a connection.
    // This also keeps the strategy safe to call directly (outside of a
    // repository that already does its own peek).
    let replayStream: PassThrough & AsyncIterable<T>
    try {
      const result = await peekAndReplayStream<T>(stream)
      replayStream = result.replayStream as PassThrough & AsyncIterable<T>
    } catch (err) {
      if (err instanceof Error && err.message === 'Stream is empty') {
        return 0
      }
      throw err
    }

    const schema = await this.getSchema(knex, table)
    const columnsToLoad = this.selectColumnsForBulkLoad(schema, objectToDBmapping)

    if (columnsToLoad.length === 0) {
      throw new Error(
        `MssqlBulkInsertStrategy: no insertable columns resolved for table "${table}". Check that objectToDBmapping references existing, non-identity, non-computed columns.`
      )
    }

    const client = knex.client as unknown as Knex.Client
    const connection = (await client.acquireConnection()) as ITediousConnection

    // A transaction-pinned connection belongs to the surrounding
    // `KnexConnectionScope` transaction, not to us: poisoning (closing) it on
    // error would tear down the transaction's connection and make knex's own
    // rollback fail with a confusing secondary error. The rollback already
    // undoes a partially-applied BulkLoad, so we leave the connection alone.
    const pinnedToTransaction = isTransactionClient(client)

    let bulkLoadError: unknown = null
    try {
      this.assertConnectionUsable(connection)
      return await this.runBulkLoad({ connection, table, stream: replayStream, columns: columnsToLoad, objectToDBmapping })
    } catch (err) {
      bulkLoadError = err
      throw err
    } finally {
      if (bulkLoadError !== null && !pinnedToTransaction) {
        this.poisonConnection(connection, bulkLoadError)
      }
      // No-op for a transaction client; returns a pooled connection to the pool.
      await client.releaseConnection(connection)
    }
  }

  private async getSchema(knex: Knex, table: string): Promise<IMssqlColumnDescriptor[]> {
    const cacheKey = normaliseTableKey(table)

    if (this.cacheSchema) {
      const cached = this.schemaCache.get(cacheKey)
      if (cached) return cached
    }

    const inspector = this.options.inspector ?? new MssqlSchemaInspector(knex)
    const schema = await inspector.inspect(table)

    if (this.cacheSchema) {
      this.schemaCache.set(cacheKey, schema)
    }
    return schema
  }

  /**
   * Resolves each entry in `objectToDBmapping` against the discovered schema
   * with case-insensitive matching (MSSQL identifiers are case-insensitive
   * under default collation). Identity / computed columns are silently
   * dropped — caller's mappings routinely include the PK, and forcing them
   * to filter manually would be noisy.
   */
  private selectColumnsForBulkLoad(schema: IMssqlColumnDescriptor[], objectToDBmapping: Record<string, string>): IMssqlColumnDescriptor[] {
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
      throw new Error(`MssqlBulkInsertStrategy: columns not found in table schema: ${missing.join(', ')}`)
    }

    return result
  }

  private runBulkLoad<T>(args: IRunBulkLoadArgs<T>): Promise<number> {
    const { connection, table, stream, columns, objectToDBmapping } = args

    return new Promise<number>((resolve, reject) => {
      let settled = false
      const rowStream = buildRowStream(stream, objectToDBmapping, columns)

      const settleReject = (err: unknown): void => {
        if (settled) return
        settled = true
        // Tear down the upstream pipeline so the producer doesn't keep
        // writing into a sink that nobody reads.
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

      // Errors in the transform must surface as the bulk-insert rejection.
      // Without this, a bad row payload would emit on the rowStream and go
      // unhandled while BulkLoad keeps waiting for input.
      rowStream.on('error', (err) => settleReject(err))

      try {
        connection.execBulkLoad(bulkLoad, rowStream)
      } catch (err) {
        settleReject(err)
      }
    })
  }

  /**
   * Guards against the knex pool returning a non-MSSQL or half-initialised
   * connection. The structural type cast in `execute()` would otherwise let
   * a `pg.Client` slip through, blowing up only at the first `newBulkLoad`
   * call — too late to release cleanly.
   */
  private assertConnectionUsable(connection: ITediousConnection): void {
    if (typeof connection.newBulkLoad !== 'function' || typeof connection.execBulkLoad !== 'function') {
      throw new Error("MssqlBulkInsertStrategy: knex client did not return a tedious-compatible connection. Verify the knex dialect is 'mssql'.")
    }
    const stateName = connection.state?.name
    if (stateName && stateName !== 'LoggedIn') {
      throw new Error(
        `MssqlBulkInsertStrategy: tedious connection is not in LoggedIn state (actual: ${stateName}). Investigate knex pool configuration.`
      )
    }
  }

  /**
   * Close the tedious connection so the next caller doesn't reuse a
   * connection that may be mid-token-stream. The pool's validator detects
   * the closed socket and drops the entry.
   *
   * Also invokes the caller's `onError` hook so app-level "poison tracking"
   * (e.g. the consumer's own pool-instrumentation) can run.
   */
  private poisonConnection(connection: ITediousConnection, err: unknown): void {
    try {
      this.options.onError?.(connection, err)
    } catch {
      // The hook is best-effort — never let it shadow the original error.
    }
    try {
      connection.close?.()
    } catch {
      // Connection may already be torn down — silent.
    }
  }
}

/**
 * True when `client` is a knex transaction client — the object exposed as
 * `trx.client` inside a transaction. Knex sets `transacting = true` only on that
 * client (via `makeTxClient`) and never on a base/pool client, so `=== true`
 * cannot false-positive on a pooled connection. On a transaction client the
 * acquired connection is pinned to the surrounding transaction and must not be
 * closed by the strategy; see `execute()` for the rationale.
 */
function isTransactionClient(client: Knex.Client): boolean {
  return (client as unknown as { transacting?: boolean }).transacting === true
}

function normaliseTableKey(table: string): string {
  // Strip surrounding brackets so 'dbo.Foo', '[dbo].[Foo]', and '[Foo]' all
  // collapse to the same cache key. MSSQL identifiers are case-insensitive
  // under default collation — lowercase to match.
  return table.toLowerCase().replace(/\[/g, '').replace(/\]/g, '').trim()
}

/**
 * Transforms the upstream domain-entity stream into row objects keyed by DB
 * column name. Plain-object / array values are stringified — MSSQL has no
 * native JSON type, so callers store JSON in NVarChar columns and expect a
 * string on the wire. Binary payloads (Buffer / typed arrays) pass through
 * unchanged for VarBinary columns.
 */
function buildRowStream<T>(
  stream: PassThrough & AsyncIterable<T>,
  objectToDBmapping: Record<string, string>,
  columns: IMssqlColumnDescriptor[]
): PassThrough {
  // Build a case-insensitive lookup from "wanted DB column" -> canonical
  // descriptor so the row keys we emit match what BulkLoad expects.
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
  // Binary payloads (VarBinary / Binary columns) must pass through to tedious
  // unchanged — JSON.stringify on a Buffer would produce `{"type":"Buffer",...}`.
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value)) return value
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}
