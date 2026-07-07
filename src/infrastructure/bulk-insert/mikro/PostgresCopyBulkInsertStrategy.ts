import { from as copyFrom } from 'pg-copy-streams'
import { PassThrough } from 'stream'
import { pipeline } from 'stream/promises'

import { buildCopyFromStdinSql, createTabRowTransform } from '../shared/pgCopyCsv'

import { IMikroBulkInsertContext, IMikroBulkInsertStrategy } from './IMikroBulkInsertStrategy'
import { KyselyChunkedBulkInsertStrategy } from './KyselyChunkedBulkInsertStrategy'

/**
 * Minimal structural subset of `pg.PoolClient` the strategy depends on.
 * Declared inline so `pg` stays an optional peer dependency at the type level.
 */
interface IPgPoolClient {
  query: (queryStream: NodeJS.WritableStream) => NodeJS.WritableStream
  release: () => void
}

/**
 * Minimal structural subset of `pg.Pool`. A function-shaped acquirer is also
 * accepted so callers can adapt non-pg pooling layers.
 */
export interface IPgPoolLike {
  connect(): Promise<IPgPoolClient>
}

export interface IPostgresCopyOptions {
  /**
   * `pg.Pool` to use for COPY. Should typically be the same pool MikroORM uses,
   * passed via `driverOptions: new PostgresDialect({ pool })`. Sharing avoids
   * doubling the connection footprint and keeps configuration in one place.
   */
  pool: IPgPoolLike

  /**
   * When `bulkInsert` is invoked inside a MikroORM-managed transaction, COPY
   * cannot participate (the transaction's connection is held by Kysely and
   * not externally accessible). With this flag (default `true`), the strategy
   * transparently falls back to `KyselyChunkedBulkInsertStrategy`, which runs
   * via the transactional Kysely instance and therefore IS in the transaction.
   * Set to `false` to throw instead.
   */
  fallbackInTransaction?: boolean

  /** Batch size for the in-transaction fallback path. Default 1000. */
  fallbackBatchSize?: number
}

/**
 * PostgreSQL streaming bulk insert via `COPY ... FROM STDIN`. Pipes the row
 * stream directly to the server using `pg-copy-streams`, which is the
 * fastest way to load large volumes into PostgreSQL (typically 10-100x
 * faster than batched multi-row INSERT for millions of rows).
 *
 * Semantics:
 *   - The COPY runs on a connection acquired from the provided `pg.Pool`,
 *     *outside* Kysely's connection management. To share state, pass the
 *     same `pg.Pool` instance to MikroORM via
 *     `driverOptions: new PostgresDialect({ pool })`.
 *   - COPY cannot run inside a MikroORM transaction (Kysely owns the
 *     transactional connection). The strategy detects that case and falls
 *     back to `KyselyChunkedBulkInsertStrategy`, so transactional bulk
 *     inserts stay correct (rollback works), just slower.
 *
 * CSV escaping mirrors the previous knex-based strategy so behavior is
 * unchanged for non-transactional callers.
 */
export class PostgresCopyBulkInsertStrategy implements IMikroBulkInsertStrategy {
  private readonly fallback: KyselyChunkedBulkInsertStrategy
  private readonly fallbackInTransaction: boolean

  public constructor(private readonly options: IPostgresCopyOptions) {
    this.fallbackInTransaction = options.fallbackInTransaction ?? true
    this.fallback = new KyselyChunkedBulkInsertStrategy(options.fallbackBatchSize)
  }

  public async execute(ctx: IMikroBulkInsertContext): Promise<number> {
    if (ctx.isInTransaction) {
      if (!this.fallbackInTransaction) {
        throw new Error(
          'PostgresCopyBulkInsertStrategy: COPY cannot run inside a MikroORM transaction (Kysely owns the connection). ' +
            'Enable `fallbackInTransaction` (default) or invoke `bulkInsert` outside `scope.transaction()`.'
        )
      }
      return this.fallback.execute(ctx)
    }

    return this.#executeCopy(ctx)
  }

  async #executeCopy(ctx: IMikroBulkInsertContext): Promise<number> {
    const { table, stream, objectToDBmapping } = ctx

    const client = await this.options.pool.connect()
    let rowCount = 0

    try {
      // pg-copy-streams expects a Writable that pg.Client.query understands —
      // typed loosely because we treat `pg` as an optional peer dep.
      const copyStream = client.query(copyFrom(buildCopyFromStdinSql(table, objectToDBmapping)))

      // pipeline (unlike .pipe chains) rejects on a failure in ANY stage —
      // source, transform, or COPY sink — and destroys the whole chain, so
      // the connection is always released and callers see the error instead
      // of the process crashing on an unhandled 'error' event.
      await pipeline(
        stream,
        createTabRowTransform(objectToDBmapping, () => rowCount++),
        copyStream as unknown as PassThrough
      )

      return rowCount
    } finally {
      try {
        client.release()
      } catch {
        // best-effort — release errors should not mask a successful COPY result
      }
    }
  }
}
