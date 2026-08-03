import type { Knex } from 'knex'
import type { Client } from 'pg'
import { PassThrough } from 'stream'
import { pipeline } from 'stream/promises'

import { IBulkInsertOptions, IBulkInsertStrategy } from '../IBulkInsertStrategy'
import { buildCopyFromStdinSql, copyFrom, createTabRowTransform } from '../shared/pgCopyCsv'

/**
 * PostgreSQL-specific bulk insert implementation using COPY command.
 * CSV serialization is shared with the Mikro-side COPY strategy
 * (`shared/pgCopyCsv.ts`).
 */
export class PostgresBulkInsertStrategy implements IBulkInsertStrategy<Knex> {
  public async execute<T>(knex: Knex, stream: PassThrough & AsyncIterable<T>, options: IBulkInsertOptions): Promise<number> {
    const { table, objectToDBmapping } = options

    const client = knex.client as unknown as Knex.Client
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const connection: Client = await client.acquireConnection()

    let rowCount = 0

    try {
      const copyStream = connection.query(copyFrom()(buildCopyFromStdinSql(table, objectToDBmapping)))

      // pipeline (unlike .pipe chains) rejects on a failure in ANY stage —
      // source, transform, or COPY sink — and destroys the whole chain, so
      // the connection is always released and callers see the error instead
      // of the process crashing on an unhandled 'error' event.
      await pipeline(
        stream,
        createTabRowTransform(objectToDBmapping, () => rowCount++),
        copyStream
      )

      return rowCount
    } finally {
      await client.releaseConnection(connection)
    }
  }
}
