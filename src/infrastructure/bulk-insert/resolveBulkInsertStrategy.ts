import { Knex } from 'knex'

import { IBulkInsertStrategy } from './IBulkInsertStrategy'
import { FallbackBulkInsertStrategy } from './mikroorm/FallbackBulkInsertStrategy'
import { PostgresBulkInsertStrategy } from './mikroorm/PostgresBulkInsertStrategy'

export function resolveBulkInsertStrategy(knex: Knex): IBulkInsertStrategy<Knex> {
  const dialect = getKnexDialect(knex)

  if (dialect === 'pg' || dialect === 'postgresql') {
    return new PostgresBulkInsertStrategy()
  }

  return new FallbackBulkInsertStrategy()
}

function getKnexDialect(knex: Knex): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return ((knex.client as Record<string, any>)?.config?.client as string) ?? ''
}
