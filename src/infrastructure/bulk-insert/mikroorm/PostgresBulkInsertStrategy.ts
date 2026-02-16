import { Knex } from 'knex'
import { Client } from 'pg'
import { from } from 'pg-copy-streams'
import { PassThrough, Transform } from 'stream'

import { IBulkInsertOptions, IBulkInsertStrategy } from '../IBulkInsertStrategy'

/**
 * PostgreSQL-specific bulk insert implementation using COPY command
 */
export class PostgresBulkInsertStrategy implements IBulkInsertStrategy<Knex> {
  public async execute<T>(knex: Knex, stream: PassThrough & AsyncIterable<T>, options: IBulkInsertOptions): Promise<number> {
    const { table, objectToDBmapping } = options

    const client = knex.client as unknown as Knex.Client
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const connection: Client = await client.acquireConnection()

    // Escape SQL identifiers by doubling embedded double-quotes
    const escapeId = (name: string) => `"${name.replace(/"/g, '""')}"`

    const columns = Object.values(objectToDBmapping)
      .map((columnName) => escapeId(columnName))
      .join(', ')

    let rowCount = 0

    try {
      const sql = `COPY ${escapeId(table)} (${columns}) FROM STDIN WITH (FORMAT csv, DELIMITER E'\\t')`
      const copyStream = connection.query(from(sql))

      // Transform stream and count rows
      const countingStream = new Transform({
        objectMode: true,
        transform(chunk, encoding, callback) {
          rowCount++
          callback(null, chunk)
        },
      })

      this.transformToTabRow(stream, objectToDBmapping).pipe(countingStream).pipe(copyStream)

      await new Promise<void>((resolve, reject) => {
        copyStream.on('finish', resolve)
        copyStream.on('error', reject)
      })

      return rowCount
    } finally {
      await client.releaseConnection(connection)
    }
  }

  private transformToTabRow(stream: PassThrough & AsyncIterable<any>, objectToDBmapping: Record<string, string>): PassThrough {
    const objectKeys = Object.keys(objectToDBmapping)

    const transformer = new Transform({
      objectMode: true,
      transform(chunk: Record<string, number | boolean | string | Date | null>, encoding, callback) {
        try {
          const orderedValues = objectKeys.map((key) => {
            let value: number | boolean | string | Date | null = null
            if (Object.prototype.hasOwnProperty.call(chunk, key)) {
              value = chunk[key]
            }

            // Handle null/undefined
            if (value == null) {
              return ''
            }

            const isDate = value instanceof Date && !isNaN(value.getTime())

            if (isDate) {
              return (<Date>value).toISOString()
            }

            // Handle objects (like JSON metadata)
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
            if (!isDate && value && typeof value === 'object') {
              const string = JSON.stringify(value)
              // Quote and escape quotes for CSV format
              return `"${string.replace(/"/g, '""')}"`
            }

            // Convert to string
            const strValue = value.toString()

            // For CSV format with tab delimiter, we need to quote fields that contain
            // special characters: tabs, newlines, quotes, or the delimiter itself
            if (strValue.includes('\t') || strValue.includes('\n') || strValue.includes('"') || strValue.includes('\r')) {
              // Quote the value and escape internal quotes by doubling them
              return `"${strValue.replace(/"/g, '""')}"`
            }

            return strValue
          })

          const line = orderedValues.join('\t') + '\n'
          callback(null, line)
        } catch (e) {
          callback(e as Error)
        }
      },
    })

    return stream.pipe(transformer)
  }
}
