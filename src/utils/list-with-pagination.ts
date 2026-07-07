import { Condition } from '@cleverjs/condition-builder'

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

  const [items, counted] = await Promise.all([
    repository.findAll({ condition, paginator, sort }),
    shouldCount ? repository.count(condition) : Promise.resolve(-1),
  ])

  if (shouldCount) {
    paginator.setTotal(counted)
    return { items, total: counted }
  }

  // Count skipped: a total cached on the paginator (from a previous call) is
  // returned as-is and preserved — setTotal(-1) here would clamp it to 0 and
  // force a re-count on the next call. -1 means "unknown" (skipTotal).
  const cached = paginator.getTotal()
  return { items, total: cached > 0 ? cached : -1 }
}
