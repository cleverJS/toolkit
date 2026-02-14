import { Knex } from 'knex'
import { AsyncLocalStorage } from 'node:async_hooks'

import { IConnectionScope, TransactionOptions } from './IConnectionScope'

export class KnexConnectionScope implements IConnectionScope<Knex> {
  private readonly als = new AsyncLocalStorage<Knex.Transaction>()

  public constructor(private readonly knex: Knex) {}

  public getConnection(): Knex {
    return this.als.getStore() ?? this.knex
  }

  public isInTransaction(): boolean {
    return this.als.getStore() !== undefined
  }

  public async transaction<T>(fn: () => Promise<T>, options?: TransactionOptions): Promise<T> {
    const active = this.als.getStore()
    const parent = active ?? this.knex
    return parent.transaction(
      async (trx) => {
        return this.als.run(trx, fn)
      },
      options?.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined
    )
  }
}
