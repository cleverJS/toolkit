import { AdapterType, Condition, ConditionAdapterRegistry, KnexConditionApplier } from '@cleverJS/condition-builder'
import { Knex } from 'knex'
import { PassThrough, Transform } from 'stream'

import { isPlainObject, removeUndefined } from '../utils/helpers/object'
import { peekAndReplayStream } from '../utils/helpers/streams'
import { Paginator } from '../utils/Paginator'
import { PropertySchema } from '../utils/types/types'

import { IBulkInsertStrategy, resolveBulkInsertStrategy } from './bulk-insert'
import { IMapper, IRepository, IRepositoryHooks } from './IRepository'
import { IConnectionScope } from './scope'
import { IFindAll, IFindAllWithSelect } from './types'

const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/

export interface IKnexRepositoryConfig<DomainEntity = any> {
  table: string
  primary?: string[]
  bulkInsertStrategy?: IBulkInsertStrategy<Knex>
  conditionRegistry: ConditionAdapterRegistry
  hooks?: IRepositoryHooks<DomainEntity>
}

export class KnexRepository<DBEntity, DomainEntity, TPrimaryKey extends keyof DomainEntity = never> implements IRepository<
  DomainEntity,
  TPrimaryKey
> {
  public readonly primary?: string[]

  public constructor(
    protected readonly scope: IConnectionScope<Knex>,
    protected readonly mapper: IMapper<DomainEntity, DBEntity>,
    protected readonly config: IKnexRepositoryConfig<DomainEntity>
  ) {
    this.primary = config.primary
  }

  private get knex(): Knex {
    return this.scope.getConnection()
  }

  public async count(condition?: Condition): Promise<number> {
    const qb = this.knex(this.config.table).count('* as count')
    this.#applyCondition(qb, condition)
    const result = await qb.first()
    return Number((result as Record<string, unknown>)?.count ?? 0)
  }

  public async delete(condition: Condition): Promise<number> {
    const qb = this.knex(this.config.table).delete()
    this.#applyCondition(qb, condition)
    return qb
  }

  public async findAll(payload: IFindAll = {}): Promise<DomainEntity[]> {
    const { condition, paginator, sort } = payload

    if (paginator && paginator.getLimit() > 1 && !sort) {
      throw new Error('Sort is required when paginator is used')
    }

    const qb = this.knex(this.config.table).select('*')

    this.#applyCondition(qb, condition)
    this.#applySort(qb, sort)
    this.#applyPaginator(qb, paginator)

    const items = await qb
    return (items as DBEntity[]).map((i) => this.mapper.toDomain(i))
  }

  public async findPartial<R>(payload: IFindAllWithSelect): Promise<R[]> {
    const { condition, paginator, sort, select = '*' } = payload

    if (paginator && paginator.getLimit() > 1 && !sort) {
      throw new Error('Sort is required when paginator is used')
    }

    const mappedSelect = this.#mapSelect(select)
    this.#validateSelectFields(mappedSelect)
    const qb = this.knex(this.config.table).select(mappedSelect)

    this.#applyCondition(qb, condition)
    this.#applySort(qb, sort)
    this.#applyPaginator(qb, paginator)

    const items = await qb
    return items as R[]
  }

  public async findOne(condition: Condition): Promise<DomainEntity | null> {
    const paginator = new Paginator({ perPage: 1 })

    const defaultSort = this.primary?.length ? { [this.primary[0]]: 'asc' as const } : undefined
    const items = await this.findAll({ condition, paginator, sort: defaultSort })

    return items.length ? items[0] : null
  }

  public async insert(data: Omit<DomainEntity, TPrimaryKey>): Promise<DomainEntity> {
    const processed = this.config.hooks?.beforeInsert?.(data as DomainEntity) ?? data
    const entity = this.mapper.toEntity(processed as DomainEntity)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const [inserted] = await this.knex(this.config.table)
      .insert(entity as Record<string, unknown>)
      .returning('*')

    return this.mapper.toDomain(inserted as DBEntity)
  }

  public async updateOne(condition: Readonly<Condition>, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity> {
    data = this.config.hooks?.beforeUpdate?.(data) ?? data
    const updateEntity = this.mapper.toPersistence(data)
    if (!isPlainObject(updateEntity)) {
      throw new Error(
        'toPersistence() must return a plain object, not a class instance. ' +
          'Class instances carry default field values that corrupt partial updates.'
      )
    }
    const cleanedEntity = removeUndefined(updateEntity as Record<string, unknown>)

    const qb = this.knex(this.config.table).select('*')
    this.#applyCondition(qb, condition)
    qb.limit(2)

    const items = await qb

    if (!items.length) {
      throw new Error('Entity to update not found')
    }

    if (items.length > 1) {
      throw new Error('Multiple entities found for update')
    }

    const item = items[0] as DBEntity
    const primaryCondition = this.#buildPrimaryCondition(item)

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const [updated] = await this.knex(this.config.table).update(cleanedEntity).where(primaryCondition).returning('*')

    return this.mapper.toDomain(updated as DBEntity)
  }

  public async update(condition: Readonly<Condition>, data: Partial<PropertySchema<DomainEntity>>): Promise<number> {
    data = this.config.hooks?.beforeUpdate?.(data) ?? data
    const updateEntity = this.mapper.toPersistence(data)
    if (!isPlainObject(updateEntity)) {
      throw new Error(
        'toPersistence() must return a plain object, not a class instance. ' +
          'Class instances carry default field values that corrupt partial updates.'
      )
    }
    const cleanedEntity = removeUndefined(updateEntity as Record<string, unknown>)

    const qb = this.knex(this.config.table).update(cleanedEntity)
    this.#applyCondition(qb, condition)
    return qb
  }

  public async insertMany<R = unknown[]>(items: Omit<DomainEntity, TPrimaryKey>[]): Promise<R> {
    if (!items.length) {
      return [] as R
    }

    const processed = this.config.hooks?.beforeInsert
      ? items.map((i) => this.config.hooks!.beforeInsert!(i as DomainEntity) as Omit<DomainEntity, TPrimaryKey>)
      : items
    const entities = processed.map((i) => this.mapper.toEntity(i as DomainEntity) as Record<string, unknown>)
    const result = await this.knex(this.config.table).insert(entities).returning('*')

    return result as R
  }

  public stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R> {
    const { select = '*', paginator, condition, sort } = payload

    const mappedSelect = this.#mapSelect(select)
    this.#validateSelectFields(mappedSelect)
    const qb = this.knex(this.config.table).select(mappedSelect)

    if (paginator) {
      if (!sort) {
        throw new Error('Sort is required when paginator is used')
      }
      this.#applyPaginator(qb, paginator)
    }

    this.#applySort(qb, sort)
    this.#applyCondition(qb, condition)

    const transformToDomain = this.#createDomainTransform()
    return qb.stream().pipe(transformToDomain) as PassThrough & AsyncIterable<R>
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

    const sample = this.config.hooks?.beforeInsert?.(first) ?? first
    const mapping = this.#buildFieldMapping(sample)
    const entityStream = this.#createEntityStream(replayStream)

    const strategy = this.config.bulkInsertStrategy ?? resolveBulkInsertStrategy(this.knex)
    return strategy.execute(this.knex, entityStream, {
      table: this.config.table,
      objectToDBmapping: mapping,
    })
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

  #applyCondition(qb: Knex.QueryBuilder, condition?: Condition): void {
    if (condition == null) {
      return
    }

    const serializer = this.config.conditionRegistry.getSerializer<KnexConditionApplier>(AdapterType.KNEX)
    const fieldMapping = this.mapper.getFieldMapping()
    const applier = serializer.serialize(condition, fieldMapping ? { fieldMapping } : undefined)
    applier(qb)
  }

  #applySort(qb: Knex.QueryBuilder, sort?: Record<string, 'asc' | 'desc'>): void {
    if (!sort) {
      return
    }
    for (const [field, dir] of Object.entries(sort)) {
      const mapped = this.#mapField(field)
      if (!SAFE_IDENTIFIER_RE.test(mapped)) {
        throw new Error(`Invalid sort field name: ${mapped}`)
      }
      qb.orderBy(mapped, dir)
    }
  }

  #applyPaginator(qb: Knex.QueryBuilder, paginator?: Paginator): void {
    if (!paginator) {
      return
    }
    if (paginator.getLimit()) {
      qb.limit(paginator.getLimit())
    }
    if (paginator.getOffset()) {
      qb.offset(paginator.getOffset())
    }
  }

  #validateSelectFields(select: string | string[]): void {
    const fields = Array.isArray(select) ? select : [select]
    for (const field of fields) {
      if (field === '*') continue
      if (!SAFE_IDENTIFIER_RE.test(field)) {
        throw new Error(`Invalid select field name: ${field}`)
      }
    }
  }

  #buildPrimaryCondition(item: DBEntity): Record<string, unknown> {
    if (!this.primary?.length) {
      throw new Error('Primary key is required for updateOne')
    }

    const condition: Record<string, unknown> = {}
    for (const key of this.primary) {
      condition[key] = item[key]
    }
    return condition
  }

  #buildFieldMapping(item: DomainEntity): Record<string, string> {
    const dbEntity = this.mapper.toEntity(item)
    const mapping: Record<string, string> = {}

    for (const key of Object.keys(dbEntity as object)) {
      if (typeof (dbEntity as Record<string, unknown>)[key] !== 'function') {
        mapping[key] = key
      }
    }

    return mapping
  }

  #createDomainTransform(): Transform {
    const mapper = this.mapper

    return new Transform({
      objectMode: true,
      transform(rawRow: Record<string, unknown>, _encoding, callback) {
        try {
          const domain = mapper.toDomain(rawRow as DBEntity)
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
