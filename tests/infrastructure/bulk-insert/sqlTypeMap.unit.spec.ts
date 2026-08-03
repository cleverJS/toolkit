import { TYPES } from 'tedious'
import { describe, expect, it } from 'vitest'

import { resolveTediousDataType } from '../../../src/infrastructure/bulk-insert/knex/mssql/sqlTypeMap'

describe('resolveTediousDataType', () => {
  it.each([
    ['bit', TYPES.Bit],
    ['int', TYPES.Int],
    ['bigint', TYPES.BigInt],
    ['decimal', TYPES.Decimal],
    ['numeric', TYPES.Numeric],
    ['datetime2', TYPES.DateTime2],
    ['datetimeoffset', TYPES.DateTimeOffset],
    ['nvarchar', TYPES.NVarChar],
    ['varbinary', TYPES.VarBinary],
    ['uniqueidentifier', TYPES.UniqueIdentifier],
  ])('maps %s to the tedious data type', (sqlType, expected) => {
    expect(resolveTediousDataType(sqlType)).toBe(expected)
  })

  it('normalises casing and surrounding whitespace', () => {
    expect(resolveTediousDataType('  NVarChar ')).toBe(TYPES.NVarChar)
  })

  it('returns the same instance across calls, so the lazily built map is reused', () => {
    expect(resolveTediousDataType('int')).toBe(resolveTediousDataType('int'))
  })

  it('throws on an unmapped type rather than guessing a wire format', () => {
    expect(() => resolveTediousDataType('geography')).toThrow('Unsupported MSSQL column type for bulk insert: "geography"')
  })
})
