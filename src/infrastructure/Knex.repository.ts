import { AdapterType, Condition, ConditionAdapterRegistry, KnexConditionApplier } from '@cleverjs/condition-builder'
import { Knex } from 'knex'
import { PassThrough, pipeline, Transform } from 'stream'

import { isPlainObject, removeUndefined } from '../utils/helpers/object'
import { peekAndReplayStream } from '../utils/helpers/streams'
import { Paginator } from '../utils/Paginator'
import { PropertySchema } from '../utils/types/types'

import { IBulkInsertStrategy, resolveBulkInsertStrategy } from './bulk-insert'
import { IMapper, IRepository, IRepositoryHooks } from './IRepository'
import { buildPrimaryKeyCondition, TPrimaryKeyPayload } from './primary-key'
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

  // Lazily resolved default bulk-insert strategy. Cached so strategy-level
  // state (e.g. the MSSQL schema cache) survives across bulkInsert() calls —
  // resolving per call would recreate the strategy with an empty cache every
  // time. Safe to cache: the dialect of a scope's connection never changes.
  #resolvedBulkInsertStrategy?: IBulkInsertStrategy<Knex>

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

  public async deleteById(id: TPrimaryKeyPayload): Promise<number> {
    return this.delete(buildPrimaryKeyCondition(this.primary, id))
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

  public async findById(id: TPrimaryKeyPayload): Promise<DomainEntity | null> {
    return this.findOne(buildPrimaryKeyCondition(this.primary, id))
  }

  public async insert(data: Omit<DomainEntity, TPrimaryKey>): Promise<DomainEntity> {
    const processed = this.config.hooks?.beforeInsert?.(data as DomainEntity) ?? data
    const entity = this.mapper.toEntity(processed as DomainEntity)
    const result: unknown = await this.knex(this.config.table)
      .insert(entity as Record<string, unknown>)
      .returning('*')

    const returned: unknown = Array.isArray(result) ? result[0] : result
    if (isRowObject(returned)) {
      return this.mapper.toDomain(returned as DBEntity)
    }

    // Dialect without RETURNING support (e.g. MySQL, where knex resolves
    // insert() with [insertId] instead of the row): re-fetch the inserted row
    // so the returned entity reflects DB defaults and triggers.
    return this.#refetchInserted(entity as Record<string, unknown>, returned)
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

    const updateResult: unknown = await this.knex(this.config.table).update(cleanedEntity).where(primaryCondition).returning('*')

    const returned: unknown = Array.isArray(updateResult) ? updateResult[0] : undefined
    if (isRowObject(returned)) {
      return this.mapper.toDomain(returned as DBEntity)
    }

    // No row means either the dialect doesn't support RETURNING (e.g. MySQL,
    // where knex resolves update() with the affected-row count) or the row was
    // deleted between the SELECT above and this UPDATE. Re-fetch by primary
    // key to distinguish the two. Note: the count alone can't tell (MySQL
    // reports 0 affected rows for a no-op update of identical values). Run
    // updateOne inside scope.transaction() if the race itself must be
    // prevented rather than detected.
    const rows = await this.knex(this.config.table).select('*').where(primaryCondition)
    if (!rows.length) {
      throw new Error('Entity to update was deleted concurrently')
    }

    return this.mapper.toDomain(rows[0] as DBEntity)
  }

  public async updateById(id: TPrimaryKeyPayload, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity> {
    return this.updateOne(buildPrimaryKeyCondition(this.primary, id), data)
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
    // pipeline (unlike .pipe) propagates source errors to the destination and
    // destroys both streams, so consumers see the failure instead of the
    // process crashing on an unhandled 'error' event.
    return pipeline(qb.stream(), transformToDomain, () => {
      // Errors surface on the destroyed destination stream; nothing to do here.
    }) as PassThrough & AsyncIterable<R>
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

    const strategy = this.config.bulkInsertStrategy ?? (this.#resolvedBulkInsertStrategy ??= resolveBulkInsertStrategy(this.knex))
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

  async #refetchInserted(entity: Record<string, unknown>, returned: unknown): Promise<DomainEntity> {
    const lookup = this.#buildInsertLookup(entity, returned)
    const rows = await this.knex(this.config.table).select('*').where(lookup)

    if (!rows.length) {
      throw new Error(`KnexRepository.insert: inserted row not found on re-fetch by ${JSON.stringify(lookup)}`)
    }

    return this.mapper.toDomain(rows[0] as DBEntity)
  }

  /**
   * Identifies the just-inserted row when the dialect returned no row.
   * Preference order:
   *   1. Primary-key values supplied in the payload itself — authoritative,
   *      covers natural and composite keys.
   *   2. The driver-reported insertId. Trusted ONLY when all of the following
   *      hold, so an arbitrary number is never mistaken for an id:
   *      - the dialect is the MySQL family (knex contractually resolves
   *        insert() with [result.insertId] there; the value comes from THIS
   *        statement's driver response, not a separate LAST_INSERT_ID() query,
   *        so pooling cannot mix up connections);
   *      - the value is a positive integer (MySQL reports 0 when the table
   *        has no auto-increment column);
   *      - the primary key is a single column (the auto-increment one).
   */
  #buildInsertLookup(entity: Record<string, unknown>, returned: unknown): Record<string, unknown> {
    const primary = this.primary ?? []

    if (primary.length > 0 && primary.every((key) => entity[key] != null)) {
      return Object.fromEntries(primary.map((key) => [key, entity[key]]))
    }

    if (primary.length === 1 && this.#isMysqlDialect() && typeof returned === 'number' && Number.isInteger(returned) && returned > 0) {
      return { [primary[0]]: returned }
    }

    throw new Error(
      'KnexRepository.insert: the dialect returned no row from INSERT ... RETURNING and the inserted row cannot be identified ' +
        '(no primary key values in the payload and no trustworthy insertId). ' +
        'Configure `primary` in the repository config or use a RETURNING-capable dialect (PostgreSQL, MSSQL).'
    )
  }

  #isMysqlDialect(): boolean {
    const client = (this.knex as unknown as { client?: { config?: { client?: string } } }).client?.config?.client
    return client === 'mysql' || client === 'mysql2'
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

    return pipeline(stream, transform, () => {
      // Errors surface on the destroyed destination stream; nothing to do here.
    }) as PassThrough & AsyncIterable<DBEntity>
  }
}

/**
 * True when a RETURNING result element is an actual row. Deliberately looser
 * than `isPlainObject`: some drivers return class instances (e.g. mysql2's
 * RowDataPacket) rather than plain objects. Numbers (MySQL insertId / affected
 * count), strings, and arrays are not rows.
 */
function isRowObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
