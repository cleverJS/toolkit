import { type Kysely, sql } from 'kysely'

import { IMssqlColumnDescriptor, IMssqlSchemaInspector, ITediousColumnOptions } from '../knex/mssql/MssqlSchemaInspector'
import { resolveTediousDataType } from '../knex/mssql/sqlTypeMap'

interface IInfoSchemaRow {
  column_name: string
  data_type: string
  is_nullable: 'YES' | 'NO'
  character_maximum_length: number | null
  numeric_precision: number | null
  numeric_scale: number | null
}

interface ISysColumnRow {
  name: string
  is_identity: number | boolean
  is_computed: number | boolean
  resolved_object_id?: number | null
}

const VARIABLE_LENGTH_TYPES = new Set(['char', 'nchar', 'varchar', 'nvarchar', 'binary', 'varbinary'])

/**
 * MSSQL schema inspector that runs raw SQL through Kysely (instead of knex's
 * `columnInfo()` + `raw()`). Used by the Mikro-side `MssqlBulkLoadBulkInsertStrategy`
 * to discover tedious-compatible column types and identity/computed flags at runtime.
 *
 * Mirrors the semantics of the knex-based `MssqlSchemaInspector`:
 *   - `information_schema.columns` for name / data_type / nullable / max length
 *   - `sys.columns` for is_identity / is_computed (not exposed by information_schema)
 *   - Variable-length types (`*char`, `*binary`) get an explicit `length` (Infinity for MAX)
 */
export class KyselyMssqlSchemaInspector implements IMssqlSchemaInspector {
  public constructor(private readonly kysely: Kysely<any>) {}

  public async inspect(table: string): Promise<IMssqlColumnDescriptor[]> {
    const [infoRows, flagsByColumn] = await Promise.all([this.fetchInfoSchema(table), this.fetchColumnFlags(table)])

    return infoRows.map<IMssqlColumnDescriptor>((row) => {
      const flags = flagsByColumn.get(row.column_name) ?? { isIdentity: false, isComputed: false }
      return {
        name: row.column_name,
        type: resolveTediousDataType(row.data_type),
        options: this.composeOptions(row),
        isIdentity: flags.isIdentity,
        isComputed: flags.isComputed,
      }
    })
  }

  private async fetchInfoSchema(table: string): Promise<IInfoSchemaRow[]> {
    const { schema, name } = splitSchemaQualified(table)
    // information_schema is case-insensitive in MSSQL under default collation, but the
    // catalog stores identifiers as written — we compare on lowercase to be safe.
    const result = schema
      ? await sql<IInfoSchemaRow>`
          SELECT
            column_name,
            data_type,
            is_nullable,
            character_maximum_length,
            numeric_precision,
            numeric_scale
          FROM information_schema.columns
          WHERE LOWER(table_name) = LOWER(${name})
            AND LOWER(table_schema) = LOWER(${schema})
          ORDER BY ordinal_position
        `.execute(this.kysely)
      : await sql<IInfoSchemaRow>`
          SELECT
            column_name,
            data_type,
            is_nullable,
            character_maximum_length,
            numeric_precision,
            numeric_scale
          FROM information_schema.columns
          WHERE LOWER(table_name) = LOWER(${name})
          ORDER BY ordinal_position
        `.execute(this.kysely)

    if (result.rows.length === 0) {
      throw new Error(`KyselyMssqlSchemaInspector: table not found or no columns visible — "${table}"`)
    }
    return result.rows
  }

  private async fetchColumnFlags(table: string): Promise<Map<string, { isIdentity: boolean; isComputed: boolean }>> {
    // `OBJECT_ID(@p0)` resolves both schema-qualified and bare names. NULL means the
    // identifier could not be resolved (often: stray brackets or wrong schema). We probe
    // separately in that case so we can throw a useful error.
    const result = await sql<ISysColumnRow>`
      SELECT
        c.name,
        c.is_identity,
        c.is_computed
      FROM sys.columns c
      WHERE c.object_id = OBJECT_ID(${table})
    `.execute(this.kysely)

    if (result.rows.length === 0) {
      const probe = await sql<{ id: number | null }>`SELECT OBJECT_ID(${table}) AS id`.execute(this.kysely)
      const resolvedId = probe.rows[0]?.id ?? null
      if (resolvedId == null) {
        throw new Error(
          `KyselyMssqlSchemaInspector: OBJECT_ID('${table}') returned NULL. Use a schema-qualified name like "dbo.MyTable" or "[dbo].[MyTable]".`
        )
      }
    }

    const map = new Map<string, { isIdentity: boolean; isComputed: boolean }>()
    for (const row of result.rows) {
      map.set(row.name, {
        isIdentity: Boolean(row.is_identity),
        isComputed: Boolean(row.is_computed),
      })
    }
    return map
  }

  private composeOptions(row: IInfoSchemaRow): ITediousColumnOptions {
    const options: ITediousColumnOptions = {
      nullable: row.is_nullable === 'YES',
    }

    const dataType = row.data_type.trim().toLowerCase()
    const maxLength = Number(row.character_maximum_length)

    if (VARIABLE_LENGTH_TYPES.has(dataType)) {
      // MSSQL reports -1 for MAX (NVarChar(MAX)) — tedious expects Infinity in that case.
      if (Number.isFinite(maxLength) && maxLength > 0) {
        options.length = maxLength
      } else {
        options.length = Infinity
      }
    }

    if (row.numeric_precision != null) {
      options.precision = Number(row.numeric_precision)
    }
    if (row.numeric_scale != null) {
      options.scale = Number(row.numeric_scale)
    }

    return options
  }
}

function splitSchemaQualified(table: string): { schema?: string; name: string } {
  // Accepts 'dbo.Foo', '[dbo].[Foo]', '[Foo]', 'Foo'. Anything more elaborate
  // (server.db.schema.table) is rejected upstream by OBJECT_ID().
  const stripped = table.replace(/\[/g, '').replace(/\]/g, '').trim()
  const parts = stripped.split('.')
  if (parts.length === 1) return { name: parts[0] }
  if (parts.length === 2) return { schema: parts[0], name: parts[1] }
  return { name: stripped }
}
