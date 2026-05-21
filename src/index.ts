// Application Layer
export { listWithPagination } from './utils/list-with-pagination'

// Infrastructure Layer
export { IRepository, IMapper, IRepositoryHooks } from './infrastructure/IRepository'
export { MikroRepository, IMikroRepositoryConfig } from './infrastructure/Mikro.repository'
export { KnexRepository, IKnexRepositoryConfig } from './infrastructure/Knex.repository'
export { IFindAll, IFindAllWithSelect, ISort } from './infrastructure/types'
export { FieldMapper, FieldMapping, IdentityMapper, MikroIdentityMapper, MikroFieldMapper } from './infrastructure/mapper'

// Connection Scope
export { IConnectionScope, IsolationLevel, TransactionOptions } from './infrastructure/scope'
export { KnexConnectionScope } from './infrastructure/scope'
export { MikroConnectionScope } from './infrastructure/scope'

// Bulk Insert Strategies
export {
  // KnexRepository-side (knex package)
  IBulkInsertStrategy,
  IBulkInsertOptions,
  PostgresBulkInsertStrategy,
  FallbackBulkInsertStrategy,
  MssqlBulkInsertStrategy,
  IMssqlBulkInsertStrategyOptions,
  MssqlSchemaInspector,
  IMssqlSchemaInspector,
  IMssqlColumnDescriptor,
  ITediousColumnOptions,
  resolveTediousDataType,
  TediousDataType,
  resolveBulkInsertStrategy,
  // MikroRepository-side (Kysely + caller-managed driver resources)
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
} from './infrastructure/bulk-insert'

// Utils
export { Cloner, ICloneable } from './utils/clone'
export { removeNullish, removeUndefined, getKeyByValue, isEmptyObject, isPlainObject, intersect } from './utils/helpers/object'
export { Paginator, IPaginatorOptions } from './utils/Paginator'
export { peekAndReplayStream } from './utils/helpers/streams'
export { convertToBoolean } from './utils/helpers/converters'
export { TClass, PropertySchema } from './utils/types/types'
export * from './utils/helpers/type-guards'
