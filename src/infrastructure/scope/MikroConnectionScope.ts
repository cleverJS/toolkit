import { EntityManager, IsolationLevel as MikroIsolationLevel } from '@mikro-orm/core'
import { AsyncLocalStorage } from 'node:async_hooks'

import { IConnectionScope, IsolationLevel, TransactionOptions } from './IConnectionScope'

const isolationLevelMap: Record<IsolationLevel, MikroIsolationLevel> = {
  'read uncommitted': MikroIsolationLevel.READ_UNCOMMITTED,
  'read committed': MikroIsolationLevel.READ_COMMITTED,
  'repeatable read': MikroIsolationLevel.REPEATABLE_READ,
  serializable: MikroIsolationLevel.SERIALIZABLE,
}

export class MikroConnectionScope implements IConnectionScope<EntityManager> {
  private readonly als = new AsyncLocalStorage<EntityManager>()

  public constructor(private readonly em: EntityManager) {}

  public getConnection(): EntityManager {
    return this.als.getStore() ?? this.em
  }

  public isInTransaction(): boolean {
    return this.als.getStore() !== undefined
  }

  public async transaction<T>(fn: () => Promise<T>, options?: TransactionOptions): Promise<T> {
    const active = this.als.getStore() ?? this.em
    return active.transactional(
      async (txEm) => {
        return this.als.run(txEm, fn)
      },
      options?.isolationLevel ? { isolationLevel: isolationLevelMap[options.isolationLevel] } : undefined
    )
  }
}
