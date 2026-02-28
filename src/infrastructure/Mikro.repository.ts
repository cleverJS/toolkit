import { AdapterType, Condition, ConditionAdapterRegistry, KnexConditionApplier } from '@cleverjs/condition-builder'
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

import { isPlainObject, removeUndefined } from '../utils/helpers/object'
import { peekAndReplayStream } from '../utils/helpers/streams'
import { KnexHelper } from '../utils/KnexHelper'
import { Paginator } from '../utils/Paginator'
import { PropertySchema } from '../utils/types/types'

import { resolveBulkInsertStrategy } from './bulk-insert'
import { IMapper, IRepository, IRepositoryHooks } from './IRepository'
import { IConnectionScope } from './scope'
import { IFindAll, IFindAllWithSelect } from './types'

const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/

type PrimaryKey = string | number

export interface IMikroRepositoryConfig<DBEntity extends BaseEntity = any, DomainEntity = any> {
  entityClass: EntityName<DBEntity>
  conditionRegistry: ConditionAdapterRegistry
  hooks?: IRepositoryHooks<DomainEntity>
}

export class MikroRepository<DBEntity extends BaseEntity, DomainEntity, TPrimaryKey extends keyof DomainEntity = never> implements IRepository<
  DomainEntity,
  TPrimaryKey
> {
  public readonly primary?: string[]

  public constructor(
    protected readonly scope: IConnectionScope<EntityManager>,
    protected readonly mapper: IMapper<DomainEntity, DBEntity>,
    protected readonly config: IMikroRepositoryConfig<DBEntity, DomainEntity>
  ) {
    const meta = this.em.getMetadata().get(this.config.entityClass)
    this.primary = meta.primaryKeys
  }

  private get em(): EntityManager {
    return this.scope.getConnection()
  }

  private get repository(): EntityRepository<DBEntity> {
    return this.em.getRepository(this.config.entityClass)
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
        const mapped = this.#mapField(field)
        MikroRepository.#validateIdentifier(mapped, 'sort')
        orderBy[mapped] = dir
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
    const mappedSelect = select ? this.#mapSelect(select) : select
    const options: FindAllOptions<DBEntity> = {
      fields: mappedSelect as unknown as FindAllOptions<DBEntity>['fields'],
    }

    if (sort) {
      const orderBy: Record<string, 'asc' | 'desc'> = {}
      for (const [field, dir] of Object.entries(sort)) {
        const mapped = this.#mapField(field)
        MikroRepository.#validateIdentifier(mapped, 'sort')
        orderBy[mapped] = dir
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
    const processed = this.config.hooks?.beforeInsert?.(data as DomainEntity) ?? data
    const entity = this.mapper.toEntity(processed as DomainEntity)
    const nextEntity = this.em.create(this.config.entityClass, entity as never)
    await this.em.persist(nextEntity).flush()

    return this.mapper.toDomain(nextEntity)
  }

  public async updateOne(condition: Readonly<Condition>, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity> {
    data = this.config.hooks?.beforeUpdate?.(data) ?? data
    const updateEntity = this.mapper.toPersistence(data) as UpdateDto<DBEntity>
    if (!isPlainObject(updateEntity)) {
      throw new Error(
        'toPersistence() must return a plain object, not a class instance. ' +
          'Class instances carry default field values that corrupt partial updates.'
      )
    }
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
    data = this.config.hooks?.beforeUpdate?.(data) ?? data
    const updateEntity = this.mapper.toPersistence(data) as EntityData<DBEntity>
    if (!isPlainObject(updateEntity)) {
      throw new Error(
        'toPersistence() must return a plain object, not a class instance. ' +
          'Class instances carry default field values that corrupt partial updates.'
      )
    }
    const cleanedEntity = removeUndefined(updateEntity)
    const filter = this.#serializeCondition(condition)

    return await this.repository.nativeUpdate(filter, cleanedEntity)
  }

  public async insertMany<R = PrimaryKey[]>(items: Omit<DomainEntity, TPrimaryKey>[]): Promise<R> {
    if (!items.length) {
      return [] as R
    }

    const processed = this.config.hooks?.beforeInsert
      ? items.map((i) => this.config.hooks!.beforeInsert!(i as DomainEntity) as Omit<DomainEntity, TPrimaryKey>)
      : items
    const entities = processed.map((i) => this.mapper.toEntity(i as DomainEntity))
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

    const mappedSelect = this.#mapSelect(select)
    if (Array.isArray(mappedSelect)) {
      for (const field of mappedSelect) {
        if (field !== '*') MikroRepository.#validateIdentifier(field, 'select')
      }
    }
    queryBuilder.select(mappedSelect)

    if (paginator) {
      if (!sort) {
        throw new Error('Sort is required when paginator is used')
      }

      this.#attachPaginatorToQB(paginator, queryBuilder)
    }

    if (sort) {
      for (const [field, dir] of Object.entries(sort)) {
        const mapped = this.#mapField(field)
        MikroRepository.#validateIdentifier(mapped, 'sort')
        queryBuilder.orderBy(mapped, dir)
      }
    }

    if (condition) {
      const serializer = this.config.conditionRegistry.getSerializer<KnexConditionApplier>(AdapterType.KNEX)
      const fieldMapping = this.mapper.getFieldMapping()
      const applier = serializer.serialize(condition, fieldMapping ? { fieldMapping } : undefined)
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

    // Apply hook to peeked item so field mapping includes hook-added fields
    const sample = this.config.hooks?.beforeInsert?.(first) ?? first

    // Build field mapping from entity properties to DB columns
    const mapping = this.#buildFieldMapping(sample)

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
    const meta = this.em.getMetadata().get(this.config.entityClass)
    return meta.tableName
  }

  #mapField(field: string): string {
    const mapping = this.mapper.getFieldMapping()
    if (!mapping) return field
    return mapping[field] ?? field
  }

  // eslint-disable-next-line sonarjs/function-return-type
  #mapSelect(select: string | string[]): string | string[] {
    if (!Array.isArray(select)) return select === '*' ? select : this.#mapField(select)
    return select.map((f) => (f === '*' ? f : this.#mapField(f)))
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

    const serializer = this.config.conditionRegistry.getSerializer<FilterQuery<DBEntity>>(AdapterType.MIKROORM)
    const fieldMapping = this.mapper.getFieldMapping()
    return serializer.serialize(condition, fieldMapping ? { fieldMapping } : undefined)
  }

  #buildFieldMapping(item: DomainEntity): Record<string, string> {
    const dbEntity = this.mapper.toEntity(item)
    const meta = this.em.getMetadata().get(this.config.entityClass)
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
    const meta = this.em.getMetadata().get(this.config.entityClass)

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
    const hooks = this.config.hooks

    const transform = new Transform({
      objectMode: true,
      transform(chunk: DomainEntity, _encoding, callback) {
        try {
          const processed = hooks?.beforeInsert?.(chunk) ?? chunk
          const entity = mapper.toEntity(processed)
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
