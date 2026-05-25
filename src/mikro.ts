// Mikro subpath — requires peers: @mikro-orm/core, kysely (+ pg/pg-copy-streams/tedious for bulk-insert paths that use them)

export { MikroRepository, IMikroRepositoryConfig } from './infrastructure/Mikro.repository'
export { MikroConnectionScope } from './infrastructure/scope/MikroConnectionScope'

// Bulk insert strategies for MikroRepository (Kysely-based, caller-managed driver resources)
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
} from './infrastructure/bulk-insert/mikro'
