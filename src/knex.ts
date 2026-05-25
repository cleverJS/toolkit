// Knex subpath — requires peers: knex, pg, pg-copy-streams, tedious (any of these only if used)

export { KnexRepository, IKnexRepositoryConfig } from './infrastructure/Knex.repository'
export { KnexConnectionScope } from './infrastructure/scope/KnexConnectionScope'

// Bulk insert strategies for KnexRepository
export { PostgresBulkInsertStrategy } from './infrastructure/bulk-insert/mikroorm/PostgresBulkInsertStrategy'
export { FallbackBulkInsertStrategy } from './infrastructure/bulk-insert/mikroorm/FallbackBulkInsertStrategy'
export { MssqlBulkInsertStrategy, IMssqlBulkInsertStrategyOptions } from './infrastructure/bulk-insert/mikroorm/MssqlBulkInsertStrategy'
export {
  MssqlSchemaInspector,
  IMssqlSchemaInspector,
  IMssqlColumnDescriptor,
  ITediousColumnOptions,
} from './infrastructure/bulk-insert/mikroorm/mssql/MssqlSchemaInspector'
export { resolveTediousDataType, TediousDataType } from './infrastructure/bulk-insert/mikroorm/mssql/sqlTypeMap'
export { resolveBulkInsertStrategy } from './infrastructure/bulk-insert/resolveBulkInsertStrategy'
