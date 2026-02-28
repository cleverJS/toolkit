import { Condition } from '@cleverjs/condition-builder'

import { Paginator } from '../utils/Paginator'

export interface IFindAll {
  condition?: Condition
  paginator?: Paginator
  sort?: ISort
}

export interface IFindAllWithSelect extends IFindAll {
  select?: string[]
}

export interface ISort {
  [field: string]: 'asc' | 'desc'
}
