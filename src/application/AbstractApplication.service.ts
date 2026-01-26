import { Condition } from '@cleverJS/condition-builder'

import { IRepository } from '../infrastructure/IRepository'
import { ISort } from '../infrastructure/types'
import { Paginator } from '../utils/Paginator'

export abstract class AbstractApplicationService<DomainEntity> {
  protected constructor(protected readonly repository: IRepository<DomainEntity>) {}

  public async list(paginator: Paginator, condition?: Condition, sort?: ISort): Promise<{ items: DomainEntity[]; total: number }> {
    const shouldCount = !paginator.getTotal() && !paginator.isSkipTotal()

    const [items, total] = await Promise.all([
      this.repository.findAll({ condition, paginator, sort }),
      shouldCount ? this.repository.count(condition) : Promise.resolve(-1),
    ])

    paginator.setTotal(total)
    return { items, total }
  }
}
