import { Condition } from '@cleverJS/condition-builder'

import { IRepository } from '../infrastructure/IRepository'
import { ISort } from '../infrastructure/types'

import { Paginator } from './Paginator'

export async function listWithPagination<DomainEntity>(
  repository: IRepository<DomainEntity>,
  paginator: Paginator,
  condition?: Condition,
  sort?: ISort
): Promise<{ items: DomainEntity[]; total: number }> {
  const shouldCount = !paginator.getTotal() && !paginator.isSkipTotal()

  const [items, total] = await Promise.all([
    repository.findAll({ condition, paginator, sort }),
    shouldCount ? repository.count(condition) : Promise.resolve(-1),
  ])

  paginator.setTotal(total)
  return { items, total }
}
