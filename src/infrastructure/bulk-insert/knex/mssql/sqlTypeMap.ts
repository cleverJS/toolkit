import type { TYPES } from 'tedious'

import { loadOptionalPeer } from '../../shared/optionalPeer'

type TediousTypes = typeof TYPES
type TediousDataType = TediousTypes[keyof TediousTypes]

let cachedMap: ReadonlyMap<string, TediousDataType> | undefined

/**
 * Maps the column `type` string returned by knex `columnInfo()` (which mirrors
 * the SQL Server data type name) to a tedious `DataType` value. Names follow
 * SQL Server's information_schema convention (lowercase, no length/precision
 * suffix).
 *
 * Built on first use, not at module load. The map's values come from tedious'
 * `TYPES`, and this module sits on the `/knex` and `/mikro` barrel graphs for
 * *every* consumer of those entries — building it eagerly would make the optional
 * `tedious` peer mandatory for Postgres-only services too. Deferring both the
 * import and the map construction keeps the requirement on the MSSQL code path,
 * which is the only path that reaches this function.
 */
function sqlTypeMap(): ReadonlyMap<string, TediousDataType> {
  if (cachedMap) return cachedMap

  const { TYPES: types } = loadOptionalPeer<{ TYPES: TediousTypes }>(
    'tedious',
    'MSSQL bulk insert',
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return
    () => require('tedious')
  )

  cachedMap = new Map<string, TediousDataType>([
    ['bit', types.Bit],
    ['tinyint', types.TinyInt],
    ['smallint', types.SmallInt],
    ['int', types.Int],
    ['bigint', types.BigInt],
    ['decimal', types.Decimal],
    ['numeric', types.Numeric],
    ['money', types.Money],
    ['smallmoney', types.SmallMoney],
    ['float', types.Float],
    ['real', types.Real],
    ['date', types.Date],
    ['datetime', types.DateTime],
    ['smalldatetime', types.SmallDateTime],
    ['datetime2', types.DateTime2],
    ['datetimeoffset', types.DateTimeOffset],
    ['time', types.Time],
    ['char', types.Char],
    ['nchar', types.NChar],
    ['varchar', types.VarChar],
    ['nvarchar', types.NVarChar],
    ['text', types.Text],
    ['ntext', types.NText],
    ['binary', types.Binary],
    ['varbinary', types.VarBinary],
    ['image', types.Image],
    ['uniqueidentifier', types.UniqueIdentifier],
  ])

  return cachedMap
}

/**
 * Unknown types throw — silent fallback would corrupt data on the wire.
 *
 * Throws with an install hint instead when the optional `tedious` peer is absent.
 */
export function resolveTediousDataType(sqlType: string): TediousDataType {
  const normalised = sqlType.trim().toLowerCase()
  const type = sqlTypeMap().get(normalised)
  if (!type) {
    throw new Error(`Unsupported MSSQL column type for bulk insert: "${sqlType}"`)
  }
  return type
}

export type { TediousDataType }
