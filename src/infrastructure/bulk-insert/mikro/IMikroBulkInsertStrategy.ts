import type { Kysely } from 'kysely'
import { PassThrough } from 'stream'

/**
 * Context passed to a Mikro-side bulk insert strategy. Strategies decide how to
 * persist the stream (multi-row INSERT, COPY, BulkLoad, ...) and use the
 * provided Kysely / scope info to honor transaction semantics.
 */
export interface IMikroBulkInsertContext {
  /** Kysely instance bound to the current scope — transactional when invoked inside `scope.transaction()`. */
  kysely: Kysely<any>
  /** True when the call is inside a MikroORM-managed transaction. */
  isInTransaction: boolean
  /** Target table name. */
  table: string
  /** Stream of DB entities (post-mapper, keyed by entity property names, not DB columns). */
  stream: PassThrough & AsyncIterable<Record<string, unknown>>
  /** Mapping from entity property name → DB column name. */
  objectToDBmapping: Record<string, string>
}

export interface IMikroBulkInsertStrategy {
  execute(ctx: IMikroBulkInsertContext): Promise<number>
}
