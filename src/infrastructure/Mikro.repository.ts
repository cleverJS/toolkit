import { AdapterType, Condition, ConditionAdapterRegistry, KyselyConditionApplier } from '@cleverjs/condition-builder'
import { BaseEntity, EntityDTO, EntityManager, EntityName, EntityRepository, FilterQuery, FromEntityType } from '@mikro-orm/core'
import type { FindAllOptions } from '@mikro-orm/core/drivers/IDatabaseDriver'
import type { EntityData } from '@mikro-orm/core/typings'
import { Kysely, SelectQueryBuilder } from 'kysely'
import { PassThrough, pipeline, Transform } from 'stream'

import { isPlainObject, removeUndefined } from '../utils/helpers/object'
import { peekAndReplayStream } from '../utils/helpers/streams'
import { Paginator } from '../utils/Paginator'
import { PropertySchema } from '../utils/types/types'

import { IMikroBulkInsertStrategy, KyselyChunkedBulkInsertStrategy } from './bulk-insert/mikro'
import { IMapper, IRepository, IRepositoryHooks } from './IRepository'
import { IConnectionScope } from './scope'
import { IFindAll, IFindAllWithSelect } from './types'

const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/

type PrimaryKey = string | number
type AnyKysely = Kysely<any>

export interface IMikroRepositoryConfig<DBEntity extends BaseEntity = any, DomainEntity = any> {
  entityClass: EntityName<DBEntity>
  conditionRegistry: ConditionAdapterRegistry
  hooks?: IRepositoryHooks<DomainEntity>
  /**
   * Bulk insert backend. Defaults to `KyselyChunkedBulkInsertStrategy` (multi-row INSERT via
   * Kysely, transactional). For high-throughput loads of millions of rows, pass
   * `PostgresCopyBulkInsertStrategy` configured with the same `pg.Pool` that MikroORM uses
   * (via `driverOptions: new PostgresDialect({ pool })`) — it pipes rows through
   * `COPY ... FROM STDIN` and falls back to chunked INSERT inside MikroORM transactions.
   */
  bulkInsertStrategy?: IMikroBulkInsertStrategy
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
    const options = this.#buildFindOptions(filter, sort, paginator)

    const items = await this.repository.findAll(options as any)

    return items.map((i) => this.mapper.toDomain(i as DBEntity))
  }

  public async findPartial<R = Partial<DomainEntity>>(payload: IFindAllWithSelect): Promise<R[]> {
    const { condition, paginator, sort, select } = payload

    if (paginator && paginator.getLimit() > 1 && !sort) {
      throw new Error('Sort is required when paginator is used')
    }

    const filter = this.#serializeCondition(condition)
    const mappedSelect = select ? this.#mapSelect(select) : select
    const options = this.#buildFindOptions(filter, sort, paginator)
    options.fields = mappedSelect as unknown as FindAllOptions<DBEntity>['fields']

    const items = await this.repository.findAll(options as any)

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

    const items = await this.repository.findAll(this.#buildFindOptions(filter, undefined, undefined, 2) as any)

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
    const nextEntities = await this.repository.insertMany(entities)

    if (!nextEntities.length) {
      return [] as R
    }

    return nextEntities as R
  }

  public stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R> {
    const { select = '*', paginator, condition, sort } = payload

    if (paginator && !sort) {
      throw new Error('Sort is required when paginator is used')
    }

    const kysely = this.getKysely()
    const table = this.getTable()
    let qb = kysely.selectFrom(table) as SelectQueryBuilder<any, string, any>

    const mappedSelect = this.#mapSelect(select)
    if (mappedSelect === '*' || (Array.isArray(mappedSelect) && mappedSelect.includes('*'))) {
      qb = qb.selectAll()
    } else if (Array.isArray(mappedSelect)) {
      for (const field of mappedSelect) {
        MikroRepository.#validateIdentifier(field, 'select')
      }
      qb = qb.select(mappedSelect)
    } else {
      MikroRepository.#validateIdentifier(mappedSelect, 'select')
      qb = qb.select([mappedSelect])
    }

    if (sort) {
      for (const [field, dir] of Object.entries(sort)) {
        const mapped = this.#mapField(field)
        MikroRepository.#validateIdentifier(mapped, 'sort')
        qb = qb.orderBy(mapped, dir)
      }
    }

    if (paginator) {
      if (paginator.getLimit()) qb = qb.limit(paginator.getLimit())
      if (paginator.getOffset()) qb = qb.offset(paginator.getOffset())
    }

    if (condition) {
      const serializer = this.config.conditionRegistry.getSerializer<KyselyConditionApplier>(AdapterType.KYSELY)
      const fieldMapping = this.mapper.getFieldMapping()
      const applier = serializer.serialize(condition, fieldMapping ? { fieldMapping } : undefined)
      qb = applier(qb)
    }

    const passThrough = new PassThrough({ objectMode: true })
    const transformToDomain = this.#createDomainStreamFromRawData()
    // pipeline (unlike .pipe) propagates the pump's destroy(err) below to the
    // destination, so consumers see the failure instead of the process
    // crashing on an unhandled 'error' event.
    pipeline(passThrough, transformToDomain, () => {
      // Errors surface on the destroyed destination stream; nothing to do here.
    })

    void (async () => {
      try {
        for await (const row of qb.stream()) {
          if (!passThrough.write(row)) {
            await new Promise<void>((resolve) => passThrough.once('drain', resolve))
          }
        }
        passThrough.end()
      } catch (err) {
        passThrough.destroy(err as Error)
      }
    })()

    return transformToDomain
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

    // Build field mapping from entity properties to DB columns from one sample row;
    // the same mapping applies to the whole stream.
    const objectToDBmapping = this.#buildFieldMapping(sample)
    const entityStream = this.#createEntityStream(replayStream)

    const strategy = this.config.bulkInsertStrategy ?? MikroRepository.#defaultBulkInsertStrategy

    return strategy.execute({
      kysely: this.getKysely(),
      isInTransaction: this.scope.isInTransaction(),
      table: this.getTable(),
      stream: entityStream,
      objectToDBmapping,
    })
  }

  protected getKysely(): AnyKysely {
    return (this.em as unknown as { getKysely(): AnyKysely }).getKysely()
  }

  protected getTable(): string {
    const meta = this.em.getMetadata().get(this.config.entityClass)
    return meta.tableName
  }

  // The new MikroORM 7 typing folds in a `WithUsingOptions` conditional over `IndexName<Entity>`,
  // which TS cannot reduce while `DBEntity` is still a free generic. The runtime shape we hand
  // back is exactly what `EntityRepository.findAll` expects, so the cast is safe.
  #buildFindOptions(
    filter: FilterQuery<DBEntity>,
    sort?: Record<string, 'asc' | 'desc'>,
    paginator?: Paginator,
    limit?: number
  ): FindAllOptionsArg<DBEntity> {
    const options: Record<string, unknown> = {}

    if (sort) {
      const orderBy: Record<string, 'asc' | 'desc'> = {}
      for (const [field, dir] of Object.entries(sort)) {
        const mapped = this.#mapField(field)
        MikroRepository.#validateIdentifier(mapped, 'sort')
        orderBy[mapped] = dir
      }
      options.orderBy = orderBy
    }

    if (paginator) {
      options.limit = paginator.getLimit()
      options.offset = paginator.getOffset()
    }

    if (limit !== undefined) {
      options.limit = limit
    }

    if (Object.keys(filter).length > 0) {
      options.where = filter
    }

    return options
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

  // eslint-disable-next-line sonarjs/function-return-type
  #serializeCondition(condition?: Condition): FilterQuery<DBEntity> {
    if (condition == null) {
      return {}
    }

    const serializer = this.config.conditionRegistry.getSerializer<FilterQuery<DBEntity>>(AdapterType.MIKROORM)
    const fieldMapping = this.mapper.getFieldMapping()
    return serializer.serialize(condition, fieldMapping ? { fieldMapping } : undefined)
  }

  #buildFieldMapping(item: DomainEntity): Record<string, string> {
    const dbEntity = this.mapper.toEntity(item)
    const meta = this.em.getMetadata().get(this.config.entityClass)
    const mapping: Record<string, string> = {}

    for (const key of Object.keys(dbEntity)) {
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

  // Transforms a domain-entity stream into a DB-entity stream (post-mapper +
  // post-hook). Strategies consume these rows keyed by entity property names
  // and apply the property→column mapping themselves.
  #createEntityStream(stream: PassThrough & AsyncIterable<DomainEntity>): PassThrough & AsyncIterable<Record<string, unknown>> {
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

    return pipeline(stream, transform, () => {
      // Errors surface on the destroyed destination stream; nothing to do here.
    }) as PassThrough & AsyncIterable<Record<string, unknown>>
  }

  static readonly #defaultBulkInsertStrategy: IMikroBulkInsertStrategy = new KyselyChunkedBulkInsertStrategy()
}

type UpdateDto<Entity> = Partial<EntityDTO<FromEntityType<Entity>>>

// Argument type for `EntityRepository.findAll` — the v7 signature wraps options in
// `WithUsingOptions<FindAllOptions<E>, E, IndexName<E>>`. We construct the option bag dynamically
// and rely on the `findAll` parameter type to validate at the call site.
type FindAllOptionsArg<E extends object> = Parameters<EntityRepository<E>['findAll']>[0] & object
