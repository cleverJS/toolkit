import type { Knex } from 'knex'

import { IBulkInsertStrategy } from './IBulkInsertStrategy'
import { FallbackBulkInsertStrategy } from './knex/FallbackBulkInsertStrategy'
import { MssqlBulkInsertStrategy } from './knex/MssqlBulkInsertStrategy'
import { PostgresBulkInsertStrategy } from './knex/PostgresBulkInsertStrategy'

export function resolveBulkInsertStrategy(knex: Knex): IBulkInsertStrategy<Knex> {
  const dialect = getKnexDialect(knex)

  if (dialect === 'pg' || dialect === 'postgresql') {
    return new PostgresBulkInsertStrategy()
  }

  if (dialect === 'mssql' || dialect === 'tedious') {
    return new MssqlBulkInsertStrategy()
  }

  return new FallbackBulkInsertStrategy()
}

function getKnexDialect(knex: Knex): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return ((knex.client as Record<string, any>)?.config?.client as string) ?? ''
}
