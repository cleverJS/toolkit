// Application Layer
export { listWithPagination } from './utils/list-with-pagination'

// Infrastructure Layer (engine-agnostic)
export { IRepository, IMapper, IRepositoryHooks } from './infrastructure/IRepository'
export { IFindAll, IFindAllWithSelect, ISort } from './infrastructure/types'
export { FieldMapper, FieldMapping, IdentityMapper, MikroIdentityMapper, MikroFieldMapper } from './infrastructure/mapper'

// Connection Scope (interface only — concrete implementations live in ./knex and ./mikro)
export { IConnectionScope, IsolationLevel, TransactionOptions } from './infrastructure/scope/IConnectionScope'

// Bulk Insert (engine-agnostic contract only — concrete strategies live in ./knex and ./mikro)
export { IBulkInsertStrategy, IBulkInsertOptions } from './infrastructure/bulk-insert/IBulkInsertStrategy'

// Utils
export { Cloner, ICloneable } from './utils/clone'
export { removeNullish, removeUndefined, getKeyByValue, isEmptyObject, isPlainObject, intersect } from './utils/helpers/object'
export { Paginator, IPaginatorOptions } from './utils/Paginator'
export { peekAndReplayStream } from './utils/helpers/streams'
export { convertToBoolean } from './utils/helpers/converters'
export { TClass, PropertySchema } from './utils/types/types'
export * from './utils/helpers/type-guards'
