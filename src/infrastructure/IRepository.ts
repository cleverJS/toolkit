import { Condition } from '@cleverJS/condition-builder'
import { PassThrough } from 'stream'

import { PropertySchema } from '../utils/types/types'

import { IFindAll, IFindAllWithSelect } from './types'

export interface IRepository<DomainEntity = any, PrimaryKey extends keyof DomainEntity = never> {
  readonly primary?: string[]

  findOne(condition: Condition): Promise<DomainEntity | null>
  findAll(payload?: IFindAll): Promise<DomainEntity[]>
  findPartial<R = Partial<DomainEntity>>(payload: IFindAllWithSelect): Promise<R[]>
  count(condition?: Condition): Promise<number>
  query<R = Record<string, any>>(sql: string, binding?: any[]): Promise<R | null>
  insert(data: Omit<DomainEntity, PrimaryKey>): Promise<DomainEntity>
  updateOne(condition: Condition, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity>
  update(condition: Condition, data: Partial<PropertySchema<DomainEntity>>): Promise<number>
  delete(condition: Condition): Promise<number>
  insertMany<R = any[]>(items: Omit<DomainEntity, PrimaryKey>[]): Promise<R>
  truncate(connection?: unknown): Promise<void>
  bulkInsert(stream: PassThrough & AsyncIterable<DomainEntity>, options?: IBulkOption): Promise<number>
  stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R>
}

export interface IMapper<DomainEntity, DBEntity> {
  toDomain(entity: DBEntity): DomainEntity
  toEntity(data: DomainEntity): DBEntity
  toPersistence(domain: Partial<PropertySchema<DomainEntity>>): Partial<DBEntity>
}

export interface IBulkOption {
  domainToEntityMap?: Record<string, string>
}
