import { Knex } from 'knex'
import { PassThrough } from 'stream'

import { IBulkInsertOptions, IBulkInsertStrategy } from '../IBulkInsertStrategy'

const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Fallback bulk insert implementation using standard INSERT statements
 * Used when database-specific optimizations are not available
 */
export class FallbackBulkInsertStrategy implements IBulkInsertStrategy<Knex> {
  private readonly batchSize: number

  public constructor(batchSize: number = 1000) {
    this.batchSize = batchSize
  }

  public async execute<T>(knex: Knex, stream: PassThrough & AsyncIterable<T>, options: IBulkInsertOptions): Promise<number> {
    const { table, objectToDBmapping } = options

    let totalRows = 0
    let batch: any[] = []

    for await (const item of stream) {
      batch.push(item)

      if (batch.length >= this.batchSize) {
        const rowsInserted = await this.insertBatch(knex, table, batch, objectToDBmapping)
        totalRows += rowsInserted
        batch = []
      }
    }

    // Insert remaining items
    if (batch.length > 0) {
      const rowsInserted = await this.insertBatch(knex, table, batch, objectToDBmapping)
      totalRows += rowsInserted
    }

    return totalRows
  }

  private async insertBatch(knex: Knex, table: string, batch: any[], objectToDBmapping: Record<string, string>): Promise<number> {
    const values = batch.map((item) => {
      const row: Record<string, any> = {}
      for (const [objectKey, dbColumn] of Object.entries(objectToDBmapping)) {
        if (DANGEROUS_PROTO_KEYS.has(dbColumn)) {
          continue
        }
        if (Object.prototype.hasOwnProperty.call(item, objectKey)) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, security/detect-object-injection
          row[dbColumn] = item[objectKey]
        }
      }
      return row
    })

    await knex(table).insert(values)
    return values.length
  }
}
