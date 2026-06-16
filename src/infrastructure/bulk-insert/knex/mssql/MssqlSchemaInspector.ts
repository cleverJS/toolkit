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
  is_identity: number | boolean
  is_computed: number | boolean
}

const VARIABLE_LENGTH_TYPES = new Set(['char', 'nchar', 'varchar', 'nvarchar', 'binary', 'varbinary'])

/**
 * Discovers MSSQL column metadata at runtime via knex `columnInfo()` plus a
 * `sys.columns` query for identity/computed flags (which `columnInfo()` does
 * not expose). The result is consumed by `MssqlBulkInsertStrategy` to build
 * tedious `BulkLoad.addColumn(...)` calls.
 *
 * Identity and computed columns must be excluded from BulkLoad payloads —
 * the server rejects writes to them unless `SET IDENTITY_INSERT ON` is in
 * scope, and BulkLoad's TDS path does not honor that toggle.
 */
export class MssqlSchemaInspector implements IMssqlSchemaInspector {
  public constructor(private readonly knex: Knex) {}

  public async inspect(table: string): Promise<IMssqlColumnDescriptor[]> {
    const [columnInfo, flagsByColumn] = await Promise.all([this.knex.table(table).columnInfo(), this.fetchColumnFlags(table)])

    const result: IMssqlColumnDescriptor[] = []

    for (const [columnName, info] of Object.entries(columnInfo)) {
      const flags = flagsByColumn.get(columnName) ?? { isIdentity: false, isComputed: false }

      result.push({
        name: columnName,
        type: resolveTediousDataType(info.type),
        options: this.composeOptions(info),
        isIdentity: flags.isIdentity,
        isComputed: flags.isComputed,
      })
    }

    return result
  }

  private composeOptions(info: Knex.ColumnInfo): ITediousColumnOptions {
    const options: ITediousColumnOptions = {
      nullable: info.nullable,
    }

    const dataType = info.type.trim().toLowerCase()
    const maxLength = Number(info.maxLength)

    if (VARIABLE_LENGTH_TYPES.has(dataType)) {
      // MSSQL reports -1 for MAX (e.g. NVarChar(MAX)) — map to Infinity for tedious.
      if (Number.isFinite(maxLength) && maxLength > 0) {
        options.length = maxLength
      } else {
        options.length = Infinity
      }
    }

    return options
  }

  private async fetchColumnFlags(table: string): Promise<Map<string, { isIdentity: boolean; isComputed: boolean }>> {
    // `OBJECT_ID(@p0)` resolves schema-qualified ("dbo.MyTable") and bare
    // names (defaulting to the caller's default schema). Returns NULL for
    // names it can't resolve — for example `[dbo].[Foo]` with embedded
    // brackets, or `db.dbo.Foo` cross-database refs in some collations.
    // We fail loudly in that case rather than returning an empty flag map,
    // which would otherwise let identity / computed columns slip into the
    // BulkLoad payload and produce a confusing server-side error.
    const sql = `
      SELECT
        OBJECT_ID(?) AS resolved_object_id,
        c.name,
        c.is_identity,
        c.is_computed
      FROM sys.columns c
      WHERE c.object_id = OBJECT_ID(?)
    `

    const raw = await this.knex.raw<
      | Array<ISysColumnRow & { resolved_object_id: number | null }>
      | { rows?: Array<ISysColumnRow & { resolved_object_id: number | null }> }
      | undefined
    >(sql, [table, table])

    // tedious/knex returns the recordset directly as an array; the
    // `{ rows }` branch keeps the inspector portable across knex versions
    // and other drivers that may wrap results.
    let rows: Array<ISysColumnRow & { resolved_object_id: number | null }>
    if (Array.isArray(raw)) {
      rows = raw
    } else if (raw && Array.isArray((raw as { rows?: Array<ISysColumnRow & { resolved_object_id: number | null }> }).rows)) {
      rows = (raw as { rows: Array<ISysColumnRow & { resolved_object_id: number | null }> }).rows
    } else {
      rows = []
    }

    // Empty result with NULL resolved_object_id can mean either the table
    // has no columns matched by the query (impossible — columnInfo would
    // have thrown) OR OBJECT_ID() couldn't resolve the name. Probe directly:
    if (rows.length === 0) {
      const resolvedId = await this.resolveObjectId(table)
      if (resolvedId == null) {
        throw new Error(
          `MssqlSchemaInspector: OBJECT_ID('${table}') returned NULL. Use a schema-qualified name like "dbo.MyTable" or "[dbo].[MyTable]".`
        )
      }
    }

    const map = new Map<string, { isIdentity: boolean; isComputed: boolean }>()
    for (const row of rows) {
      map.set(row.name, {
        isIdentity: Boolean(row.is_identity),
        isComputed: Boolean(row.is_computed),
      })
    }
    return map
  }

  private async resolveObjectId(table: string): Promise<number | null> {
    const probe = await this.knex.raw<Array<{ id: number | null }> | { rows?: Array<{ id: number | null }> }>('SELECT OBJECT_ID(?) AS id', [table])
    let probeRows: Array<{ id: number | null }>
    if (Array.isArray(probe)) {
      probeRows = probe
    } else if (probe != null && Array.isArray((probe as { rows?: Array<{ id: number | null }> }).rows)) {
      probeRows = (probe as { rows: Array<{ id: number | null }> }).rows
    } else {
      probeRows = []
    }
    const first = probeRows[0]
    return first != null ? first.id : null
  }
}
