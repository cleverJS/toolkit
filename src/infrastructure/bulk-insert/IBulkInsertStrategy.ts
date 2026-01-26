import { EntityManager } from '@mikro-orm/core'
import { Knex } from '@mikro-orm/knex'
import { PassThrough } from 'stream'

/**
 * Interface for database-specific bulk insert strategies
 */
export interface IBulkInsertStrategy {
  /**
   * Check if this strategy is supported by the current database
   */
  isSupported(em: EntityManager): boolean

  /**
   * Perform bulk insert operation
   * @param knex - Knex instance
   * @param stream - Stream of data to insert
   * @param options - Configuration options including table name and field mappings
   * @returns Promise that resolves to the number of rows inserted
   */
  execute<T>(knex: Knex, stream: PassThrough & AsyncIterable<T>, options: IBulkInsertOptions): Promise<number>
}

export interface IBulkInsertOptions {
  table: string
  objectToDBmapping: Record<string, string>
}
