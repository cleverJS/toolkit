import { AdapterType, Condition, ConditionAdapterRegistry, KnexConditionApplier } from '@cleverJS/condition-builder'
import {
  BaseEntity,
  EntityDTO,
  EntityManager,
  EntityName,
  EntityRepository,
  FilterQuery,
  FromEntityType,
  OrderDefinition,
  RequiredEntityData,
} from '@mikro-orm/core'
import type { FindAllOptions } from '@mikro-orm/core/drivers/IDatabaseDriver'
import type { EntityData } from '@mikro-orm/core/typings'
import { Knex } from '@mikro-orm/knex'
import { PassThrough, Transform } from 'stream'

import { removeUndefined } from '../utils/helpers/object'
import { peekAndReplayStream } from '../utils/helpers/streams'
import { KnexHelper } from '../utils/KnexHelper'
import { Paginator } from '../utils/Paginator'
import { PropertySchema } from '../utils/types/types'

import { resolveBulkInsertStrategy } from './bulk-insert'
import { IMapper, IRepository } from './IRepository'
import { IConnectionScope } from './scope/IConnectionScope'
import { IFindAll, IFindAllWithSelect } from './types'

const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/

type PrimaryKey = string | number

export class MikroRepository<DBEntity extends BaseEntity, DomainEntity, TPrimaryKey extends keyof DomainEntity = never> implements IRepository<
  DomainEntity,
  TPrimaryKey
> {
  public readonly primary?: string[]

  public constructor(
    protected readonly scope: IConnectionScope<EntityManager>,
    protected readonly entityClass: EntityName<DBEntity>,
    protected readonly mapper: IMapper<DomainEntity, DBEntity>
  ) {
    const meta = this.em.getMetadata().get(this.entityClass)
    this.primary = meta.primaryKeys
  }

  private get em(): EntityManager {
    return this.scope.getConnection()
  }

  private get repository(): EntityRepository<DBEntity> {
    return this.em.getRepository(this.entityClass)
  }

  public async count(condition?: Condition): Promise<number> {
    const filter = this.#serializeCondition(condition)
    return this.repository.count(filter)
  }

  public async delete(condition: Condition): Promise<number> {
    const filter = this.#serializeCondition(condition)
    return this.repository.nativeDelete(filter)
  }

  public async findAll(payload: IFindAll = {}): Promise<DomainEntity[]> {
    const { condition, paginator, sort } = payload

    if (paginator && paginator.getLimit() > 1 && !sort) {
      throw new Error('Sort is required when paginator is used')
    }

    const filter = this.#serializeCondition(condition)
    const options: FindAllOptions<DBEntity> = {}

    if (sort) {
      const orderBy: Record<string, 'asc' | 'desc'> = {}
      for (const [field, dir] of Object.entries(sort)) {
        MikroRepository.#validateIdentifier(field, 'sort')
        orderBy[field] = dir
      }
      options.orderBy = orderBy as OrderDefinition<DBEntity>
    }

    if (paginator) {
      options.limit = paginator.getLimit()
      options.offset = paginator.getOffset()
    }

    if (Object.keys(filter).length > 0) {
      options.where = filter
    }

    const items = await this.repository.findAll(options)

    return items.map((i) => this.mapper.toDomain(i))
  }

  public async findPartial<R = Partial<DomainEntity>>(payload: IFindAllWithSelect): Promise<R[]> {
    const { condition, paginator, sort, select } = payload

    if (paginator && paginator.getLimit() > 1 && !sort) {
      throw new Error('Sort is required when paginator is used')
    }

    const filter = this.#serializeCondition(condition)
    const options: FindAllOptions<DBEntity> = {
      fields: select as unknown as FindAllOptions<DBEntity>['fields'],
    }

    if (sort) {
      const orderBy: Record<string, 'asc' | 'desc'> = {}
      for (const [field, dir] of Object.entries(sort)) {
        MikroRepository.#validateIdentifier(field, 'sort')
        orderBy[field] = dir
      }
      options.orderBy = orderBy as OrderDefinition<DBEntity>
    }

    if (paginator) {
      options.limit = paginator.getLimit()
      options.offset = paginator.getOffset()
    }

    if (Object.keys(filter).length > 0) {
      options.where = filter
    }

    const items = await this.repository.findAll(options)

    return items as unknown as R[]
  }

  public async findOne(condition: Condition): Promise<DomainEntity | null> {
    const paginator = new Paginator({ perPage: 1 })

    // Use primary key for deterministic ordering when no sort is specified
    const defaultSort = this.primary?.length ? { [this.primary[0]]: 'asc' as const } : undefined
    const items = await this.findAll({ condition, paginator, sort: defaultSort })

    return items.length ? items[0] : null
  }

  public async insert(data: Omit<DomainEntity, TPrimaryKey>): Promise<DomainEntity> {
    const entity = this.mapper.toEntity(data as DomainEntity)
    const nextEntity = this.em.create(this.entityClass, entity as never)
    await this.em.persist(nextEntity).flush()

    return this.mapper.toDomain(nextEntity)
  }

  public async updateOne(condition: Readonly<Condition>, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity> {
    const updateEntity = this.mapper.toPersistence(data) as UpdateDto<DBEntity>
    const cleanedEntity = removeUndefined(updateEntity)
    const filter = this.#serializeCondition(condition)

    const items = await this.repository.findAll({ where: filter, limit: 2 })

    if (!items.length) {
      throw new Error('Entity to update not found')
    }

    if (items.length > 1) {
      throw new Error('Multiple entities found for update')
    }

    const item = items[0]

    item.assign(cleanedEntity)
    await this.em.flush()

    return this.mapper.toDomain(item)
  }

  public async update(condition: Readonly<Condition>, data: Partial<PropertySchema<DomainEntity>>): Promise<number> {
    const updateEntity = this.mapper.toPersistence(data) as EntityData<DBEntity>
    const cleanedEntity = removeUndefined(updateEntity)
    const filter = this.#serializeCondition(condition)

    return await this.repository.nativeUpdate(filter, cleanedEntity)
  }

  public async insertMany<R = PrimaryKey[]>(items: Omit<DomainEntity, TPrimaryKey>[]): Promise<R> {
    if (!items.length) {
      return [] as R
    }

    const entities = items.map((i) => this.mapper.toEntity(i as DomainEntity))
    // MikroORM's insertMany() requires MikroEntity[] or RequiredEntityData[], but our mapper returns Partial<EntityDTO>[]
    // We use type assertion because at runtime the mapper provides the correct structure
    const nextEntities = await this.repository.insertMany(entities as unknown as RequiredEntityData<DBEntity>[])

    if (!nextEntities.length) {
      return [] as R
    }

    return nextEntities as R
  }

  public stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R> {
    const { select = '*', paginator, condition, sort } = payload

    const knex = this.getKnex()
    const queryBuilder = knex.queryBuilder<DBEntity, R[]>()

    queryBuilder.from(this.getTable())

    if (Array.isArray(select)) {
      for (const field of select) {
        if (field !== '*') MikroRepository.#validateIdentifier(field, 'select')
      }
    }
    queryBuilder.select(select)

    if (paginator) {
      if (!sort) {
        throw new Error('Sort is required when paginator is used')
      }

      this.#attachPaginatorToQB(paginator, queryBuilder)
    }

    if (sort) {
      for (const [field, dir] of Object.entries(sort)) {
        MikroRepository.#validateIdentifier(field, 'sort')
        queryBuilder.orderBy(field, dir)
      }
    }

    if (condition) {
      const serializer = ConditionAdapterRegistry.getInstance().getSerializer<KnexConditionApplier>(AdapterType.KNEX)
      const applier = serializer.serialize(condition)
      applier(queryBuilder)
    }

    const transformToDomain = this.#createDomainStreamFromRawData()
    return queryBuilder.stream().pipe(transformToDomain) as PassThrough & AsyncIterable<R>
  }

  public async bulkInsert(stream: PassThrough & AsyncIterable<DomainEntity>): Promise<number> {
    let first: DomainEntity
    let replayStream: PassThrough

    try {
      const result = await peekAndReplayStream<DomainEntity>(stream)
      first = result.first
      replayStream = result.replayStream
    } catch (error) {
      if (error instanceof Error && error.message === 'Stream is empty') {
        return 0
      }
      throw error
    }

    if (!first) {
      return 0
    }

    // Build field mapping from entity properties to DB columns
    const mapping = this.#buildFieldMapping(first)

    // Convert domain entities to database entities stream
    const entityStream = this.#createEntityStream(replayStream)

    const knex = this.em.getTransactionContext<Knex>() ?? this.getKnex()
    const strategy = resolveBulkInsertStrategy(knex)

    return strategy.execute(knex, entityStream, {
      table: this.getTable(),
      objectToDBmapping: mapping,
    })
  }

  protected getKnex(): Knex {
    return KnexHelper.getKnex(this.em)
  }

  protected getTable(): string {
    const meta = this.em.getMetadata().get(this.entityClass)
    return meta.tableName
  }

  static #validateIdentifier(name: string, context: string): void {
    if (!SAFE_IDENTIFIER_RE.test(name)) {
      throw new Error(`Invalid ${context} field name: ${name}`)
    }
  }

  #attachPaginatorToQB(paginator: Paginator, qb: Knex.QueryBuilder<DBEntity, any[]>): void {
    if (paginator.getLimit()) {
      qb.limit(paginator.getLimit())
    }

    if (paginator.getOffset()) {
      qb.offset(paginator.getOffset())
    }
  }

  // eslint-disable-next-line sonarjs/function-return-type
  #serializeCondition(condition?: Condition): FilterQuery<DBEntity> {
    if (condition == null) {
      return {} as FilterQuery<DBEntity>
    }

    const serializer = ConditionAdapterRegistry.getInstance().getSerializer<FilterQuery<DBEntity>>(AdapterType.MIKROORM)
    return serializer.serialize(condition)
  }

  #buildFieldMapping(item: DomainEntity): Record<string, string> {
    const dbEntity = this.mapper.toEntity(item)
    const meta = this.em.getMetadata().get(this.entityClass)
    const mapping: Record<string, string> = {}

    for (const key of Object.keys(dbEntity as object)) {
      if (typeof (dbEntity as Record<string, unknown>)[key] === 'function') {
        continue
      }

      const prop = meta.props.find((p) => p.name === key)
      if (!prop) continue
      if (prop.primary && prop.autoincrement) continue

      mapping[key] = prop.fieldNames[0]
    }

    return mapping
  }

  #buildDbToEntityMapping(): Record<string, string> {
    const meta = this.em.getMetadata().get(this.entityClass)

    // Build reverse mapping: dbColumn -> entityProperty
    const dbToEntityMapping: Record<string, string> = {}
    for (const prop of meta.props) {
      const dbField = prop.fieldNames[0]
      dbToEntityMapping[dbField] = prop.name
    }

    return dbToEntityMapping
  }

  #createDomainStreamFromRawData(): Transform {
    const mapper = this.mapper
    const dbToEntityMapping = this.#buildDbToEntityMapping()

    return new Transform({
      objectMode: true,
      transform(rawRow: Record<string, unknown>, _encoding, callback) {
        try {
          // Convert DB row (snake_case) to entity shape (camelCase)
          const entityData: Record<string, unknown> = {}
          for (const [dbField, value] of Object.entries(rawRow)) {
            const entityField = dbToEntityMapping[dbField] ?? dbField
            entityData[entityField] = value
          }

          // Now convert to domain using the mapper
          const domain = mapper.toDomain(entityData as DBEntity)
          callback(null, domain)
        } catch (err) {
          callback(err as Error)
        }
      },
    })
  }

  #createEntityStream(stream: PassThrough & AsyncIterable<DomainEntity>): PassThrough & AsyncIterable<DBEntity> {
    const mapper = this.mapper

    const transform = new Transform({
      objectMode: true,
      transform(chunk: DomainEntity, _encoding, callback) {
        try {
          const entity = mapper.toEntity(chunk)
          callback(null, entity)
        } catch (error) {
          callback(error as Error)
        }
      },
    })

    return stream.pipe(transform) as PassThrough & AsyncIterable<DBEntity>
  }
}

type UpdateDto<Entity> = Partial<EntityDTO<FromEntityType<Entity>>>
