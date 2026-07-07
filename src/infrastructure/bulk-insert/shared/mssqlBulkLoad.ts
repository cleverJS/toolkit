import { PassThrough, pipeline, Transform } from 'stream'

import { IMssqlColumnDescriptor } from '../knex/mssql/MssqlSchemaInspector'

/**
 * Shared core of the MSSQL BulkLoad strategies. `MssqlBulkInsertStrategy`
 * (knex) and `MssqlBulkLoadBulkInsertStrategy` (Mikro/Kysely) differ only in
 * how they acquire/release the tedious connection and discover the schema —
 * the BulkLoad execution, row serialization, and column selection are
 * identical and live here so fixes apply to both paths at once.
 *
 * All tedious types are declared structurally to keep `tedious` an optional
 * peer dependency at the type level.
 */

/** Structural subset of `tedious.BulkLoad`. */
export interface ITediousBulkLoad {
  setTimeout(ms: number): void
  addColumn(name: string, type: unknown, options: unknown): void
}

/** Structural subset of `tedious.Connection` — only the BulkLoad-related members. */
export interface ITediousConnection {
  newBulkLoad(table: string, options: unknown, callback: (err: Error | null | undefined, rowCount?: number) => void): ITediousBulkLoad
  execBulkLoad(bulkLoad: ITediousBulkLoad, rows: AsyncIterable<unknown> | Iterable<unknown>): void
  close?(): void
  state?: { name?: string }
}

/** tedious BulkLoad behavior flags — see `Options` in `tedious/lib/bulk-load.d.ts`. */
export interface IMssqlBulkLoadFlags {
  checkConstraints?: boolean
  fireTriggers?: boolean
  keepNulls?: boolean
  lockTable?: boolean
  order?: Record<string, 'ASC' | 'DESC'>
}

export interface IRunBulkLoadArgs<T> {
  connection: ITediousConnection
  table: string
  stream: PassThrough & AsyncIterable<T>
  columns: IMssqlColumnDescriptor[]
  objectToDBmapping: Record<string, string>
  /** BulkLoad request timeout in ms. `0` (tedious default) inherits the connection's `requestTimeout`. */
  timeout?: number
  bulkOptions?: IMssqlBulkLoadFlags
}

/**
 * Normalises a table name into a schema-cache key: strips brackets so
 * 'dbo.Foo', '[dbo].[Foo]', and '[Foo]' collapse to the same key. MSSQL
 * identifiers are case-insensitive under default collation — lowercase to match.
 */
export function normaliseTableKey(table: string): string {
  return table.toLowerCase().replace(/\[/g, '').replace(/\]/g, '').trim()
}

/**
 * Resolves each entry in `objectToDBmapping` against the discovered schema
 * with case-insensitive matching (MSSQL identifiers are case-insensitive
 * under default collation). Identity / computed columns are silently
 * dropped — caller's mappings routinely include the PK, and forcing them
 * to filter manually would be noisy.
 *
 * @param strategyName prefixes error messages so failures point at the strategy in use
 */
export function selectColumnsForBulkLoad(
  schema: IMssqlColumnDescriptor[],
  objectToDBmapping: Record<string, string>,
  strategyName: string
): IMssqlColumnDescriptor[] {
  const byLowerName = new Map(schema.map((c) => [c.name.toLowerCase(), c]))
  const wantedDbColumns = new Set(Object.values(objectToDBmapping))

  const missing: string[] = []
  const seen = new Set<string>()
  const result: IMssqlColumnDescriptor[] = []

  for (const dbColumn of wantedDbColumns) {
    const col = byLowerName.get(dbColumn.toLowerCase())
    if (!col) {
      missing.push(dbColumn)
      continue
    }
    if (col.isIdentity || col.isComputed) continue
    if (seen.has(col.name)) continue
    seen.add(col.name)
    result.push(col)
  }

  if (missing.length > 0) {
    throw new Error(`${strategyName}: columns not found in table schema: ${missing.join(', ')}`)
  }

  return result
}

/**
 * Executes a tedious BulkLoad over the given connection, streaming rows from
 * `stream` (keyed by entity property names) mapped to DB column names.
 * Settles exactly once: on the BulkLoad completion callback, on a row
 * serialization error, or on a synchronous `execBulkLoad` throw. On failure
 * the upstream pipeline is torn down so the producer doesn't keep writing
 * into a sink that nobody reads.
 */
export function runBulkLoad<T>(args: IRunBulkLoadArgs<T>): Promise<number> {
  const { connection, table, stream, columns, objectToDBmapping, timeout, bulkOptions } = args

  return new Promise<number>((resolve, reject) => {
    let settled = false
    const rowStream = buildRowStream(stream, objectToDBmapping, columns)

    const settleReject = (err: unknown): void => {
      if (settled) return
      settled = true
      const error = err instanceof Error ? err : new Error(String(err))
      rowStream.destroy(error)
      if (typeof stream.destroy === 'function') {
        stream.destroy(err instanceof Error ? err : undefined)
      }
      reject(error)
    }

    const settleResolve = (rowCount: number): void => {
      if (settled) return
      settled = true
      resolve(rowCount)
    }

    const bulkLoad = connection.newBulkLoad(table, bulkOptions ?? {}, (error, rowCount) => {
      if (error) {
        settleReject(error)
        return
      }
      settleResolve(rowCount ?? 0)
    })

    if (typeof timeout === 'number') {
      bulkLoad.setTimeout(timeout)
    }

    for (const col of columns) {
      bulkLoad.addColumn(col.name, col.type, col.options)
    }

    // Errors in the transform must surface as the bulk-insert rejection.
    // Without this, a bad row payload would emit on the rowStream and go
    // unhandled while BulkLoad keeps waiting for input.
    rowStream.on('error', (err) => settleReject(err))

    try {
      connection.execBulkLoad(bulkLoad, rowStream)
    } catch (err) {
      settleReject(err)
    }
  })
}

/**
 * Transforms the upstream entity stream into row objects keyed by DB column
 * name. Plain-object / array values are stringified — MSSQL has no native
 * JSON type, so callers store JSON in NVarChar columns and expect a string on
 * the wire. Binary payloads (Buffer / typed arrays) pass through unchanged
 * for VarBinary columns.
 */
function buildRowStream<T>(
  stream: PassThrough & AsyncIterable<T>,
  objectToDBmapping: Record<string, string>,
  columns: IMssqlColumnDescriptor[]
): Transform {
  // Build a case-insensitive lookup from "wanted DB column" -> canonical
  // descriptor so the row keys we emit match what BulkLoad expects.
  const canonicalByLower = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]))
  const reverseMapping: Array<[string, string]> = []
  for (const [objKey, dbCol] of Object.entries(objectToDBmapping)) {
    const canonical = canonicalByLower.get(dbCol.toLowerCase())
    if (canonical) {
      reverseMapping.push([objKey, canonical])
    }
  }

  const transformer = new Transform({
    objectMode: true,
    transform(chunk: Record<string, unknown>, _enc, callback) {
      try {
        const row: Record<string, unknown> = {}
        for (const [objKey, dbCol] of reverseMapping) {
          if (!Object.prototype.hasOwnProperty.call(chunk, objKey)) {
            // eslint-disable-next-line security/detect-object-injection
            row[dbCol] = null
            continue
          }
          // eslint-disable-next-line security/detect-object-injection
          const value = chunk[objKey]
          // eslint-disable-next-line security/detect-object-injection
          row[dbCol] = serialiseValue(value)
        }
        callback(null, row)
      } catch (err) {
        callback(err as Error)
      }
    },
  })

  // pipeline (unlike .pipe) propagates source errors to the transformer, whose
  // 'error' listener in runBulkLoad settles the BulkLoad promise — otherwise a
  // source failure is an unhandled 'error' event and crashes the process.
  return pipeline(stream, transformer, () => {
    // Errors surface via the transformer's 'error' event; nothing to do here.
  })
}

function serialiseValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value
  // Binary payloads (VarBinary / Binary columns) must pass through to tedious
  // unchanged — JSON.stringify on a Buffer would produce `{"type":"Buffer",...}`.
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value)) return value
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}
