import type { Knex } from 'knex'
import { PassThrough } from 'stream'

import { peekAndReplayStream } from '../../../utils/helpers/streams'
import { IBulkInsertOptions, IBulkInsertStrategy } from '../IBulkInsertStrategy'
import { IMssqlBulkLoadFlags, ITediousConnection, normaliseTableKey, runBulkLoad, selectColumnsForBulkLoad } from '../shared/mssqlBulkLoad'

import { IMssqlColumnDescriptor, IMssqlSchemaInspector, MssqlSchemaInspector } from './mssql/MssqlSchemaInspector'

const STRATEGY_NAME = 'MssqlBulkInsertStrategy'

export interface IMssqlBulkInsertStrategyOptions {
  /**
   * BulkLoad request timeout in ms. `0` (tedious default) falls back to the
   * connection's `requestTimeout`.
   */
  timeout?: number

  /**
   * tedious BulkLoad behavior flags — see `Options` in `tedious/lib/bulk-load.d.ts`.
   */
  bulkOptions?: IMssqlBulkLoadFlags

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

/**
 * MSSQL bulk insert via tedious' TDS BulkLoad (BCP) path. Materially faster
 * than knex's `batchInsert` (which hits the 2100-parameter TDS limit and
 * issues one INSERT per batch).
 *
 * The strategy:
 *   1. Acquires a raw `tedious.Connection` from the knex pool.
 *   2. Discovers the column schema (`sys.columns`, incl. identity / computed
 *      flags) and caches it per-table (case-insensitive).
 *   3. Runs the shared BulkLoad core (`shared/mssqlBulkLoad.ts`): one
 *      `addColumn(...)` per non-identity, non-computed column referenced in
 *      `objectToDBmapping`, rows streamed as an AsyncIterable.
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
    const columnsToLoad = selectColumnsForBulkLoad(schema, objectToDBmapping, STRATEGY_NAME)

    if (columnsToLoad.length === 0) {
      throw new Error(
        `${STRATEGY_NAME}: no insertable columns resolved for table "${table}". Check that objectToDBmapping references existing, non-identity, non-computed columns.`
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
   * Guards against the knex pool returning a non-MSSQL or half-initialised
   * connection. The structural type cast in `execute()` would otherwise let
   * a `pg.Client` slip through, blowing up only at the first `newBulkLoad`
   * call — too late to release cleanly.
   */
  private assertConnectionUsable(connection: ITediousConnection): void {
    if (typeof connection.newBulkLoad !== 'function' || typeof connection.execBulkLoad !== 'function') {
      throw new Error(`${STRATEGY_NAME}: knex client did not return a tedious-compatible connection. Verify the knex dialect is 'mssql'.`)
    }
    const stateName = connection.state?.name
    if (stateName && stateName !== 'LoggedIn') {
      throw new Error(`${STRATEGY_NAME}: tedious connection is not in LoggedIn state (actual: ${stateName}). Investigate knex pool configuration.`)
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
