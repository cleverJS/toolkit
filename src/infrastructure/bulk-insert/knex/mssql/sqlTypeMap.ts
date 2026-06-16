import { TYPES } from 'tedious'

type TediousTypes = typeof TYPES
type TediousDataType = TediousTypes[keyof TediousTypes]

/**
 * Maps the column `type` string returned by knex `columnInfo()` (which mirrors
 * the SQL Server data type name) to a tedious `DataType` value. Names follow
 * SQL Server's information_schema convention (lowercase, no length/precision
 * suffix).
 *
 * Unknown types throw — silent fallback would corrupt data on the wire.
 */
const SQL_TYPE_MAP: ReadonlyMap<string, TediousDataType> = new Map<string, TediousDataType>([
  ['bit', TYPES.Bit],
  ['tinyint', TYPES.TinyInt],
  ['smallint', TYPES.SmallInt],
  ['int', TYPES.Int],
  ['bigint', TYPES.BigInt],
  ['decimal', TYPES.Decimal],
  ['numeric', TYPES.Numeric],
  ['money', TYPES.Money],
  ['smallmoney', TYPES.SmallMoney],
  ['float', TYPES.Float],
  ['real', TYPES.Real],
  ['date', TYPES.Date],
  ['datetime', TYPES.DateTime],
  ['smalldatetime', TYPES.SmallDateTime],
  ['datetime2', TYPES.DateTime2],
  ['datetimeoffset', TYPES.DateTimeOffset],
  ['time', TYPES.Time],
  ['char', TYPES.Char],
  ['nchar', TYPES.NChar],
  ['varchar', TYPES.VarChar],
  ['nvarchar', TYPES.NVarChar],
  ['text', TYPES.Text],
  ['ntext', TYPES.NText],
  ['binary', TYPES.Binary],
  ['varbinary', TYPES.VarBinary],
  ['image', TYPES.Image],
  ['uniqueidentifier', TYPES.UniqueIdentifier],
])

export function resolveTediousDataType(sqlType: string): TediousDataType {
  const normalised = sqlType.trim().toLowerCase()
  const type = SQL_TYPE_MAP.get(normalised)
  if (!type) {
    throw new Error(`Unsupported MSSQL column type for bulk insert: "${sqlType}"`)
  }
  return type
}

export type { TediousDataType }
