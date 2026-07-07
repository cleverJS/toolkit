import { Condition } from '@cleverjs/condition-builder'
import { PassThrough } from 'stream'

import { PropertySchema } from '../utils/types/types'

import { TPrimaryKeyPayload } from './primary-key'
import { IFindAll, IFindAllWithSelect } from './types'

export interface IRepository<DomainEntity = any, PrimaryKey extends keyof DomainEntity = never> {
  readonly primary?: string[]

  findOne(condition: Condition): Promise<DomainEntity | null>
  /**
   * findOne by primary key. Pass a scalar for a single-column key or a
   * `{ column: value }` object for composite keys (keys must match
   * `repository.primary`). Throws when the repository has no primary key
   * configured or the payload doesn't cover it exactly.
   */
  findById(id: TPrimaryKeyPayload): Promise<DomainEntity | null>
  findAll(payload?: IFindAll): Promise<DomainEntity[]>
  findPartial<R = Partial<DomainEntity>>(payload: IFindAllWithSelect): Promise<R[]>
  count(condition?: Condition): Promise<number>
  insert(data: Omit<DomainEntity, PrimaryKey>): Promise<DomainEntity>
  updateOne(condition: Condition, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity>
  /** updateOne by primary key — same payload rules as findById. */
  updateById(id: TPrimaryKeyPayload, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity>
  update(condition: Condition, data: Partial<PropertySchema<DomainEntity>>): Promise<number>
  delete(condition: Condition): Promise<number>
  /** delete by primary key — same payload rules as findById. Returns the number of deleted rows (0 or 1). */
  deleteById(id: TPrimaryKeyPayload): Promise<number>
  insertMany<R = any[]>(items: Omit<DomainEntity, PrimaryKey>[]): Promise<R>
  bulkInsert(stream: PassThrough & AsyncIterable<DomainEntity>): Promise<number>
  stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R>
}

export interface IMapper<DomainEntity, DBEntity> {
  toDomain(entity: DBEntity): DomainEntity
  toEntity(data: DomainEntity): DBEntity
  toPersistence(domain: Partial<PropertySchema<DomainEntity>>): Partial<DBEntity>
  getFieldMapping(): Record<string, string> | undefined
}

export interface IRepositoryHooks<DomainEntity> {
  beforeInsert?(data: DomainEntity): DomainEntity
  beforeUpdate?(data: Partial<PropertySchema<DomainEntity>>): Partial<PropertySchema<DomainEntity>>
}
