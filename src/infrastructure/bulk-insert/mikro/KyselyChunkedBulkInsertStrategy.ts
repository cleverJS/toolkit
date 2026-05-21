import { IMikroBulkInsertContext, IMikroBulkInsertStrategy } from './IMikroBulkInsertStrategy'

const DEFAULT_BATCH_SIZE = 1000

/**
 * Default Mikro bulk insert strategy: chunked multi-row INSERT via Kysely.
 *
 * Participates in MikroORM transactions because Kysely is bound to the current
 * scope (transactional when inside `scope.transaction()`).
 *
 * Performance: O(rows / batchSize) round-trips. Adequate for tens of thousands
 * of rows; use `PostgresCopyBulkInsertStrategy` for millions.
 */
export class KyselyChunkedBulkInsertStrategy implements IMikroBulkInsertStrategy {
  private readonly batchSize: number

  public constructor(batchSize: number = DEFAULT_BATCH_SIZE) {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error(`KyselyChunkedBulkInsertStrategy: batchSize must be a positive integer, got ${batchSize}`)
    }
    this.batchSize = batchSize
  }

  public async execute(ctx: IMikroBulkInsertContext): Promise<number> {
    const { kysely, table, stream, objectToDBmapping } = ctx
    const objectKeys = Object.keys(objectToDBmapping)

    let total = 0
    let batch: Record<string, unknown>[] = []

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return
      await kysely.insertInto(table).values(batch).execute()
      total += batch.length
      batch = []
    }

    for await (const item of stream as AsyncIterable<Record<string, unknown>>) {
      const row: Record<string, unknown> = {}
      for (const key of objectKeys) {
        // eslint-disable-next-line security/detect-object-injection
        const dbCol = objectToDBmapping[key]
        if (Object.prototype.hasOwnProperty.call(item, key)) {
          // eslint-disable-next-line security/detect-object-injection
          row[dbCol] = item[key]
        }
      }
      batch.push(row)

      if (batch.length >= this.batchSize) {
        await flush()
      }
    }

    await flush()
    return total
  }
}
