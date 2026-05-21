import { Kysely } from 'kysely'

import { detectKyselyDialect, KyselyDialect } from './detectKyselyDialect'
import { IMikroBulkInsertStrategy } from './IMikroBulkInsertStrategy'
import { KyselyChunkedBulkInsertStrategy } from './KyselyChunkedBulkInsertStrategy'
import { ITediousConnectionFactory, MssqlBulkLoadBulkInsertStrategy } from './MssqlBulkLoadBulkInsertStrategy'
import { IPgPoolLike, PostgresCopyBulkInsertStrategy } from './PostgresCopyBulkInsertStrategy'

export interface IMikroBulkInsertResolverDeps {
  /** Kysely instance used for dialect detection. Pass `em.getKysely()`. */
  kysely: Kysely<any>

  /**
   * Optional override of the detected dialect. Useful for tests or when running
   * against a dialect Kysely doesn't expose recognizably (e.g. custom adapters).
   */
  dialect?: KyselyDialect

  /**
   * PostgreSQL: shared `pg.Pool` for streaming COPY. When provided AND the
   * detected dialect is `postgres`, `PostgresCopyBulkInsertStrategy` is returned.
   * Typically you pass the same pool to MikroORM via
   * `driverOptions: new PostgresDialect({ pool })` and to this resolver.
   */
  pgPool?: IPgPoolLike

  /**
   * MSSQL: tedious connection factory for BulkLoad. When provided AND the
   * detected dialect is `mssql`, `MssqlBulkLoadBulkInsertStrategy` is returned.
   */
  mssqlFactory?: ITediousConnectionFactory

  /** Batch size for the fallback / chunked path (default 1000). */
  fallbackBatchSize?: number
}

/**
 * Picks an `IMikroBulkInsertStrategy` based on the Kysely dialect and which
 * driver-specific resources the caller provided.
 *
 * Selection rules:
 *   - `postgres` + `pgPool` → `PostgresCopyBulkInsertStrategy` (streaming COPY)
 *   - `mssql` + `mssqlFactory` → `MssqlBulkLoadBulkInsertStrategy` (TDS BulkLoad)
 *   - anything else → `KyselyChunkedBulkInsertStrategy` (multi-row INSERT)
 *
 * Mirrors the role of the legacy knex-side `resolveBulkInsertStrategy(knex)`,
 * adapted for MikroRepository: the dialect comes from Kysely, and the
 * driver-specific resources come from the caller (since Kysely doesn't expose
 * its internal `pg.Pool` / tedious connections).
 */
export function resolveMikroBulkInsertStrategy(deps: IMikroBulkInsertResolverDeps): IMikroBulkInsertStrategy {
  const dialect = deps.dialect ?? detectKyselyDialect(deps.kysely)

  if (dialect === 'postgres' && deps.pgPool) {
    return new PostgresCopyBulkInsertStrategy({
      pool: deps.pgPool,
      fallbackBatchSize: deps.fallbackBatchSize,
    })
  }

  if (dialect === 'mssql' && deps.mssqlFactory) {
    return new MssqlBulkLoadBulkInsertStrategy({
      factory: deps.mssqlFactory,
      fallbackBatchSize: deps.fallbackBatchSize,
    })
  }

  return new KyselyChunkedBulkInsertStrategy(deps.fallbackBatchSize)
}
