export { IBulkInsertStrategy, IBulkInsertOptions } from './IBulkInsertStrategy'
export { PostgresBulkInsertStrategy } from './mikroorm/PostgresBulkInsertStrategy'
export { FallbackBulkInsertStrategy } from './mikroorm/FallbackBulkInsertStrategy'
export { MssqlBulkInsertStrategy, IMssqlBulkInsertStrategyOptions } from './mikroorm/MssqlBulkInsertStrategy'
export { MssqlSchemaInspector, IMssqlSchemaInspector, IMssqlColumnDescriptor, ITediousColumnOptions } from './mikroorm/mssql/MssqlSchemaInspector'
export { resolveTediousDataType, TediousDataType } from './mikroorm/mssql/sqlTypeMap'
export { resolveBulkInsertStrategy } from './resolveBulkInsertStrategy'

// MikroRepository-side strategies (use Kysely + caller-managed driver resources).
// For the Knex-based strategies above (used by KnexRepository), see `IBulkInsertStrategy`.
export {
  IMikroBulkInsertContext,
  IMikroBulkInsertStrategy,
  KyselyChunkedBulkInsertStrategy,
  PostgresCopyBulkInsertStrategy,
  IPostgresCopyOptions,
  IPgPoolLike,
  MssqlBulkLoadBulkInsertStrategy,
  IMssqlBulkLoadOptions,
  ITediousConnection,
  ITediousConnectionFactory,
  KyselyMssqlSchemaInspector,
  detectKyselyDialect,
  KyselyDialect,
  resolveMikroBulkInsertStrategy,
  IMikroBulkInsertResolverDeps,
} from './mikro'
