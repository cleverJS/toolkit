import { Kysely } from 'kysely'
import { PassThrough } from 'stream'

import { peekAndReplayStream } from '../../../utils/helpers/streams'
import { IMssqlColumnDescriptor, IMssqlSchemaInspector } from '../knex/mssql/MssqlSchemaInspector'
import { IMssqlBulkLoadFlags, ITediousConnection, normaliseTableKey, runBulkLoad, selectColumnsForBulkLoad } from '../shared/mssqlBulkLoad'

import { IMikroBulkInsertContext, IMikroBulkInsertStrategy } from './IMikroBulkInsertStrategy'
import { KyselyChunkedBulkInsertStrategy } from './KyselyChunkedBulkInsertStrategy'
import { KyselyMssqlSchemaInspector } from './KyselyMssqlSchemaInspector'

const STRATEGY_NAME = 'MssqlBulkLoadBulkInsertStrategy'

// Re-exported for API stability: this type was declared here before the
// BulkLoad core moved to shared/mssqlBulkLoad.ts, and it is part of the
// public `@cleverjs/toolkit/mikro` surface (via ITediousConnectionFactory).
export type { ITediousConnection }

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
  bulkOptions?: IMssqlBulkLoadFlags

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
 * Why a separate code path from `MssqlBulkInsertStrategy`: the knex-based
 * strategy expects a `Knex.Client` to acquire a tedious connection. MikroORM v7
 * ships Kysely instead, and Kysely's MssqlDialect hides its tedious connections
 * behind hash-private fields. The Mikro variant therefore takes a caller-managed
 * `ITediousConnectionFactory` so the user controls connection lifecycle. The
 * BulkLoad execution itself is shared with the knex strategy
 * (`shared/mssqlBulkLoad.ts`).
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
          `${STRATEGY_NAME}: BulkLoad cannot run inside a MikroORM transaction (Kysely owns the connection). ` +
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
    const columnsToLoad = selectColumnsForBulkLoad(schema, objectToDBmapping, STRATEGY_NAME)

    if (columnsToLoad.length === 0) {
      throw new Error(
        `${STRATEGY_NAME}: no insertable columns resolved for table "${table}". Verify that objectToDBmapping references existing, non-identity, non-computed columns.`
      )
    }

    const connection = await this.options.factory.acquire()
    this.#assertConnectionUsable(connection)

    let bulkLoadError: unknown = null
    try {
      return await runBulkLoad({
        connection,
        table,
        stream: replayStream,
        columns: columnsToLoad,
        objectToDBmapping,
        timeout: this.options.timeout,
        bulkOptions: this.options.bulkOptions,
      })
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

  #assertConnectionUsable(connection: ITediousConnection): void {
    if (typeof connection.newBulkLoad !== 'function' || typeof connection.execBulkLoad !== 'function') {
      throw new Error(`${STRATEGY_NAME}: factory.acquire() did not return a tedious-compatible connection.`)
    }
    const stateName = connection.state?.name
    if (stateName && stateName !== 'LoggedIn') {
      throw new Error(`${STRATEGY_NAME}: tedious connection is not in LoggedIn state (actual: ${stateName}).`)
    }
  }
}
