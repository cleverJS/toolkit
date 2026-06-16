export { IBulkInsertStrategy, IBulkInsertOptions } from './IBulkInsertStrategy'
export { PostgresBulkInsertStrategy } from './knex/PostgresBulkInsertStrategy'
export { FallbackBulkInsertStrategy } from './knex/FallbackBulkInsertStrategy'
export { MssqlBulkInsertStrategy, IMssqlBulkInsertStrategyOptions } from './knex/MssqlBulkInsertStrategy'
export { MssqlSchemaInspector, IMssqlSchemaInspector, IMssqlColumnDescriptor, ITediousColumnOptions } from './knex/mssql/MssqlSchemaInspector'
export { resolveTediousDataType, TediousDataType } from './knex/mssql/sqlTypeMap'
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
