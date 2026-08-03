export { IBulkInsertStrategy, IBulkInsertOptions } from './IBulkInsertStrategy'
export { PostgresBulkInsertStrategy } from './knex/PostgresBulkInsertStrategy'
export { FallbackBulkInsertStrategy } from './knex/FallbackBulkInsertStrategy'
export { MssqlBulkInsertStrategy, IMssqlBulkInsertStrategyOptions } from './knex/MssqlBulkInsertStrategy'
export { MssqlSchemaInspector, IMssqlSchemaInspector, IMssqlColumnDescriptor, ITediousColumnOptions } from './knex/mssql/MssqlSchemaInspector'
export { resolveTediousDataType, TediousDataType } from './knex/mssql/sqlTypeMap'
export { resolveBulkInsertStrategy } from './resolveBulkInsertStrategy'

// The MikroRepository-side strategies are deliberately NOT re-exported here. They
// value-import `kysely`, and this barrel is on the `/knex` entry's graph via
// `Knex.repository` — re-exporting them made a knex-only consumer load Kysely (and
// everything else the Mikro strategies touch) just to import `@cleverjs/toolkit/knex`.
// Engine-specific strategies stay behind their own entry: `./mikro` / `/mikro`.
