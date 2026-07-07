import { Knex } from 'knex'

import { resolveTediousDataType, TediousDataType } from './sqlTypeMap'

/**
 * Mirrors tedious' (non-exported) `ColumnOptions` interface from
 * `lib/bulk-load.d.ts`. Declared structurally so the strategy compiles even
 * when tedious is absent at build time (it's an optional peer dependency).
 */
export interface ITediousColumnOptions {
  output?: boolean
  length?: number
  precision?: number
  scale?: number
  objName?: string
  nullable?: boolean
}

export interface IMssqlColumnDescriptor {
  name: string
  type: TediousDataType
  options: ITediousColumnOptions
  isIdentity: boolean
  isComputed: boolean
}

export interface IMssqlSchemaInspector {
  inspect(table: string): Promise<IMssqlColumnDescriptor[]>
}

interface ISysColumnRow {
  name: string
  data_type: string
  is_nullable: number | boolean
  is_identity: number | boolean
  is_computed: number | boolean
  max_length: number
  precision: number
  scale: number
}

const VARIABLE_LENGTH_TYPES = new Set(['char', 'nchar', 'varchar', 'nvarchar', 'binary', 'varbinary'])
const WIDE_CHAR_TYPES = new Set(['nchar', 'nvarchar'])
const DECIMAL_TYPES = new Set(['decimal', 'numeric'])

/**
 * Discovers MSSQL column metadata at runtime from a single, schema-aware
 * `sys.columns` query (keyed by `OBJECT_ID`). The result is consumed by
 * `MssqlBulkInsertStrategy` to build tedious `BulkLoad.addColumn(...)` calls.
 *
 * A SINGLE query is deliberate (it replaces an earlier `Promise.all` of knex
 * `columnInfo()` + a `sys.columns` flags query) for two reasons:
 *   1. Correctness inside a transaction. The strategy may run the inspector on
 *      the transaction's single pinned connection; two concurrent requests on
 *      one tedious connection throw `EINVALIDSTATE` ("Requests can only be made
 *      in the LoggedIn state..."). One round-trip is always safe.
 *   2. Schema-awareness. knex `columnInfo()` defaults the schema to `dbo`, so it
 *      returned zero columns for tables in other schemas (e.g. `[onboarding].*`).
 *      `OBJECT_ID` resolves the (optionally schema-qualified) name correctly.
 *
 * Identity and computed columns are reported so the strategy can exclude them —
 * the server rejects BulkLoad writes to them unless `SET IDENTITY_INSERT ON` is
 * in scope, which BulkLoad's TDS path does not honor. `precision`/`scale` are
 * reported for `decimal`/`numeric` so DECIMAL(p,s) values keep their scale
 * (without them tedious defaults scale to 0 and truncates the fraction).
 */
export class MssqlSchemaInspector implements IMssqlSchemaInspector {
  public constructor(private readonly knex: Knex) {}

  public async inspect(table: string): Promise<IMssqlColumnDescriptor[]> {
    const rows = await this.fetchColumns(table)

    if (rows.length === 0) {
      throw new Error(
        `MssqlSchemaInspector: OBJECT_ID('${table}') resolved no columns — the table does not exist or the name is not resolvable. Use a schema-qualified name like "dbo.MyTable" or "[onboarding].[MyTable]".`
      )
    }

    return rows.map((row) => ({
      name: row.name,
      type: resolveTediousDataType(row.data_type),
      options: this.composeOptions(row),
      isIdentity: Boolean(row.is_identity),
      isComputed: Boolean(row.is_computed),
    }))
  }

  private composeOptions(row: ISysColumnRow): ITediousColumnOptions {
    const options: ITediousColumnOptions = { nullable: Boolean(row.is_nullable) }
    const dataType = row.data_type.trim().toLowerCase()

    if (VARIABLE_LENGTH_TYPES.has(dataType)) {
      // sys.columns.max_length is in BYTES; -1 means MAX (→ Infinity for tedious).
      // nchar/nvarchar store 2 bytes per char, so halve to recover the char length.
      if (row.max_length === -1) {
        options.length = Infinity
      } else {
        options.length = WIDE_CHAR_TYPES.has(dataType) ? row.max_length / 2 : row.max_length
      }
    }

    if (DECIMAL_TYPES.has(dataType)) {
      options.precision = Number(row.precision)
      options.scale = Number(row.scale)
    }

    return options
  }

  private async fetchColumns(table: string): Promise<ISysColumnRow[]> {
    // `OBJECT_ID(?)` resolves schema-qualified ("dbo.MyTable", "[onboarding].[T]")
    // and bare names (against the caller's default schema), returning NULL for
    // names it can't resolve — which yields zero rows and a loud error in
    // `inspect`, rather than letting identity/computed columns slip into the
    // BulkLoad payload. `TYPE_NAME(system_type_id)` yields the base type name
    // even for alias types. `max_length`/`precision`/`scale` come straight from
    // sys.columns so DECIMAL scale and (n)char/(n)varchar lengths are exact.
    const sql = `
      SELECT
        c.name AS name,
        TYPE_NAME(c.system_type_id) AS data_type,
        c.is_nullable AS is_nullable,
        c.is_identity AS is_identity,
        c.is_computed AS is_computed,
        c.max_length AS max_length,
        c.precision AS [precision],
        c.scale AS scale
      FROM sys.columns c
      WHERE c.object_id = OBJECT_ID(?)
      ORDER BY c.column_id
    `

    const raw = await this.knex.raw<ISysColumnRow[] | { rows?: ISysColumnRow[] } | undefined>(sql, [table])

    // tedious/knex returns the recordset directly as an array; the `{ rows }`
    // branch keeps the inspector portable across knex versions / wrappers.
    if (Array.isArray(raw)) {
      return raw
    }
    if (raw && Array.isArray(raw.rows)) {
      return (raw as { rows: ISysColumnRow[] }).rows
    }
    return []
  }
}
