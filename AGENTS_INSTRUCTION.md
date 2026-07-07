# @cleverjs/toolkit — AI Reference

> Concise API reference for AI assistants. Read this instead of exploring the source tree.

## Package overview

TypeScript library: generic Repository pattern, bulk insert strategies, connection scoping (transactions), deep cloning, pagination, and object helpers. All ORM/DB peer dependencies are optional for tree-shaking.

**Import paths:**

```ts
// Engine-agnostic core: interfaces, mappers, utilities, IBulkInsertStrategy contract
import { IRepository, IConnectionScope, FieldMapper, IdentityMapper, Paginator, ... } from '@cleverjs/toolkit'

// Knex-backed repository, scope, and bulk insert strategies (requires peers: knex, pg, pg-copy-streams, tedious)
import { KnexRepository, KnexConnectionScope, resolveBulkInsertStrategy, ... } from '@cleverjs/toolkit/knex'

// MikroORM-backed repository, scope, and Kysely-based bulk insert strategies (requires peers: @mikro-orm/core, kysely)
import { MikroRepository, MikroConnectionScope, resolveMikroBulkInsertStrategy, ... } from '@cleverjs/toolkit/mikro'

// Object helpers only
import { removeNullish, removeUndefined, ... } from '@cleverjs/toolkit/objects'
```

> Engine-bound symbols (`KnexRepository`, `MikroRepository`, `KnexConnectionScope`, `MikroConnectionScope`, all concrete bulk-insert strategies) are **not** exported from the root barrel `@cleverjs/toolkit` — import from `/knex` or `/mikro` subpath so peers stay optional.

---

## 1. Repository pattern

### IRepository\<DomainEntity, PrimaryKey\>

Generic repository interface. Two implementations: `MikroRepository` (MikroORM) and `KnexRepository` (raw Knex).

```ts
interface IRepository<DomainEntity = any, PrimaryKey extends keyof DomainEntity = never> {
  readonly primary?: string[]

  findOne(condition: Condition): Promise<DomainEntity | null>
  findById(id: TPrimaryKeyPayload): Promise<DomainEntity | null>
  findAll(payload?: IFindAll): Promise<DomainEntity[]>
  findPartial<R = Partial<DomainEntity>>(payload: IFindAllWithSelect): Promise<R[]>
  count(condition?: Condition): Promise<number>
  insert(data: Omit<DomainEntity, PrimaryKey>): Promise<DomainEntity>
  updateOne(condition: Condition, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity>
  updateById(id: TPrimaryKeyPayload, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity>
  update(condition: Condition, data: Partial<PropertySchema<DomainEntity>>): Promise<number>
  delete(condition: Condition): Promise<number>
  deleteById(id: TPrimaryKeyPayload): Promise<number>
  insertMany<R = any[]>(items: Omit<DomainEntity, PrimaryKey>[]): Promise<R>
  bulkInsert(stream: PassThrough & AsyncIterable<DomainEntity>): Promise<number>
  stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R>
}

// TPrimaryKeyPayload = string | number | Date | Record<string, string | number | Date>
```

**Constraints:**
- `findAll` / `findPartial` / `stream`: when `paginator` is provided with `limit > 1`, `sort` is **required** (throws otherwise).
- `findById` / `updateById` / `deleteById`: sugar over `findOne`/`updateOne`/`delete` with an equality condition on `repository.primary`. Scalar for a single-column key; `{ column: value }` (keys = `repository.primary`, DB-side names) for composite keys. Throw on: no primary key configured, nullish id, scalar for composite key, missing/extra/null keys in the object payload — misuse never widens the filter. Helper `buildPrimaryKeyCondition(primary, id)` is exported for custom implementations.
- `updateOne`: throws if zero or more than one entity matches the condition, and (KnexRepository) if the row is deleted between its SELECT and UPDATE — run inside `scope.transaction()` to prevent rather than detect that race.
- `KnexRepository.insert` / `updateOne` use `INSERT/UPDATE ... RETURNING` on PostgreSQL/MSSQL. On dialects without RETURNING (e.g. MySQL) they re-fetch the row with one extra SELECT (by payload PK values, else by `insertId` — trusted only on mysql/mysql2, single-column PK, positive integer). If the row cannot be identified, they throw — configure `primary`.

### IMapper\<DomainEntity, DBEntity\>

Separates domain models from DB entities. Every repository requires a mapper.

```ts
interface IMapper<DomainEntity, DBEntity> {
  toDomain(entity: DBEntity): DomainEntity
  toEntity(data: DomainEntity): DBEntity
  toPersistence(domain: Partial<PropertySchema<DomainEntity>>): Partial<DBEntity>
  getFieldMapping(): Record<string, string> | undefined
}
```

### Built-in mappers

Four built-in implementations cover the common cases. Use a custom `IMapper` only for complex transformations (computed fields, nested objects).

| Mapper | Use case | `toEntity()` returns |
|---|---|---|
| `IdentityMapper<Entity>` | Knex — domain and DB shapes identical | plain object |
| `FieldMapper<Domain, DBEntity>` | Knex — domain and DB have different field names | plain object |
| `MikroIdentityMapper<Domain, DBEntity>` | MikroORM — same field names | class instance (`new EntityClass()`) |
| `MikroFieldMapper<Domain, DBEntity>` | MikroORM — different field names | class instance (`new EntityClass()`) |

MikroORM's identity map requires entity class instances, not plain objects. The `Mikro*` mappers handle this via `new EntityClass()` + `Object.assign()`.

```ts
// Knex — identity (same field names)
new IdentityMapper<User>()
new IdentityMapper<User>(['email', 'name'])  // optional field whitelist

// Knex — field mapping (keys = domain names, values = DB column names)
new FieldMapper<User, UserRow>({ isActive: 'is_active', createdAt: 'created_at' })

// MikroORM — identity
new MikroIdentityMapper<User, UserEntity>(UserEntity)

// MikroORM — field mapping
new MikroFieldMapper<User, UserEntity>(UserEntity, { isActive: 'is_active' })
```

### Query types

```ts
interface IFindAll {
  condition?: Condition        // from @cleverjs/condition-builder
  paginator?: Paginator
  sort?: ISort
}
interface IFindAllWithSelect extends IFindAll {
  select?: string[]
}
interface ISort { [field: string]: 'asc' | 'desc' }
```

### IRepositoryHooks\<DomainEntity\>

Optional write lifecycle hooks passed to repository constructors. Runs before mapper transformation on all write paths (`insert`, `insertMany`, `updateOne`, `update`, `bulkInsert`).

```ts
interface IRepositoryHooks<DomainEntity> {
  beforeInsert?(data: DomainEntity): DomainEntity
  beforeUpdate?(data: Partial<PropertySchema<DomainEntity>>): Partial<PropertySchema<DomainEntity>>
}
```

### MikroRepository

Targets MikroORM **v7**, which replaced Knex with Kysely as the underlying query builder. `getKysely()` returns the Kysely instance bound to the current scope (transactional inside `scope.transaction()`).

```ts
class MikroRepository<
  DBEntity extends BaseEntity,
  DomainEntity,
  TPrimaryKey extends keyof DomainEntity = never
> implements IRepository<DomainEntity, TPrimaryKey> {
  constructor(
    scope: IConnectionScope<EntityManager>,
    mapper: IMapper<DomainEntity, DBEntity>,
    config: IMikroRepositoryConfig<DBEntity, DomainEntity>,
  )
  protected getKysely(): Kysely<any>   // access underlying Kysely (transactional when in tx)
  protected getTable(): string         // table name from entity metadata
}

interface IMikroRepositoryConfig<DBEntity extends BaseEntity = any, DomainEntity = any> {
  entityClass: EntityName<DBEntity>
  conditionRegistry: ConditionAdapterRegistry
  hooks?: IRepositoryHooks<DomainEntity>
  /**
   * Bulk insert backend. Defaults to `KyselyChunkedBulkInsertStrategy` (chunked
   * multi-row INSERT via Kysely, transactional). For million-row loads, pass
   * a dialect-specific strategy resolved via `resolveMikroBulkInsertStrategy()`.
   */
  bulkInsertStrategy?: IMikroBulkInsertStrategy
}
```

**MikroORM 7 setup notes:**

- Recommended entity declaration is `defineEntity({ class, tableName, properties: p => ({...}) })` from `@mikro-orm/core`. No decorators, no `reflect-metadata`, no `experimentalDecorators` / `emitDecoratorMetadata` in tsconfig. Pass the resulting schema to `MikroORM.init({ entities: [...] })`; pass the class to `entityClass`/`MikroIdentityMapper` (the class still carries the metadata).
- Decorators are still supported via the optional `@mikro-orm/decorators` package — `/legacy` (TS experimental, needs `reflect-metadata` + `metadataProvider: ReflectMetadataProvider`) or `/es` (stage-3 standard, explicit `type` annotations required). Install separately if you want them; not needed for `defineEntity`.
- `orm.schema.dropSchema()` / `createSchema()` were renamed to `drop()` / `create()`.
- `em.getKnex()` is **gone**. `em.getKysely()` is the v7 equivalent; the repository wraps it via `getKysely()`.
- To share a `pg.Pool` with the COPY strategy, pass it via `driverOptions: new PostgresDialect({ pool })` to `MikroORM.init`.

### KnexRepository

```ts
class KnexRepository<
  DBEntity extends Record<string, unknown>,
  DomainEntity,
  TPrimaryKey extends keyof DomainEntity = never
> implements IRepository<DomainEntity, TPrimaryKey> {
  constructor(
    scope: IConnectionScope<Knex>,
    mapper: IMapper<DomainEntity, DBEntity>,
    config: IKnexRepositoryConfig<DomainEntity>,
  )
}

interface IKnexRepositoryConfig<DomainEntity = any> {
  table: string
  primary?: string[]
  bulkInsertStrategy?: IBulkInsertStrategy<Knex>
  conditionRegistry: ConditionAdapterRegistry
  hooks?: IRepositoryHooks<DomainEntity>
}
```

---

## 2. Connection scope (transactions)

Uses `AsyncLocalStorage` internally. Nested `transaction()` calls create savepoints.

```ts
type IsolationLevel = 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'

interface IConnectionScope<TConnection = unknown> {
  getConnection(): TConnection      // base connection or active transaction
  isInTransaction(): boolean
  transaction<T>(fn: () => Promise<T>, options?: { isolationLevel?: IsolationLevel }): Promise<T>
}
```

| Class | TConnection | Requires |
|---|---|---|
| `MikroConnectionScope` | `EntityManager` | `@mikro-orm/core` |
| `KnexConnectionScope` | `Knex` | `knex` |

---

## 3. Bulk insert strategies

Two parallel families. Pick the one matching the repository:

| Repository | Strategy family | Resolver |
|---|---|---|
| `KnexRepository` | `IBulkInsertStrategy<Knex>` (Knex package) | `resolveBulkInsertStrategy(knex)` |
| `MikroRepository` | `IMikroBulkInsertStrategy` (Kysely + caller-managed driver) | `resolveMikroBulkInsertStrategy(deps)` |

### 3.1 KnexRepository side (`IBulkInsertStrategy`)

```ts
interface IBulkInsertStrategy<TConnection = unknown> {
  execute<T>(
    connection: TConnection,
    stream: PassThrough & AsyncIterable<T>,
    options: { table: string; objectToDBmapping: Record<string, string> }
  ): Promise<number>
}
```

| Strategy | Mechanism |
|---|---|
| `PostgresBulkInsertStrategy` | PostgreSQL `COPY ... FROM STDIN` (tab-delimited). |
| `MssqlBulkInsertStrategy` | SQL Server TDS `BulkLoad` (BCP) via tedious. Schema auto-discovered from knex's `columnInfo()` + `sys.columns`, cached per table. |
| `FallbackBulkInsertStrategy` | Batched `INSERT` (default batch 1000). Any DB. |

```ts
function resolveBulkInsertStrategy(knex: Knex): IBulkInsertStrategy<Knex>
// 'pg' / 'postgresql' → PostgresBulkInsertStrategy
// 'mssql' / 'tedious' → MssqlBulkInsertStrategy
// everything else     → FallbackBulkInsertStrategy
```

`KnexRepository.bulkInsert()` resolves automatically; override via `IKnexRepositoryConfig.bulkInsertStrategy`.

**Transaction semantics** — inside `scope.transaction()` knex hands the strategy the transaction's *pinned* connection (`acquireConnection()` returns that single connection; `releaseConnection()` is a no-op), so `COPY` / `BulkLoad` run on the transaction's own session and commit/roll back **atomically** with it — there is no separate auto-committing connection. Caveat: a transaction pins one connection, so never run `bulkInsert()` concurrently with other repo calls in the same transaction (await sequentially) — concurrent use corrupts the wire protocol. MSSQL: a failed `BulkLoad` closes (poisons) a *pooled* connection so the pool drops it, but a *transaction-pinned* connection is left open for the transaction's rollback to clean up.

### 3.2 MikroRepository side (`IMikroBulkInsertStrategy`)

MikroORM v7's Kysely manages its own connection pool with hash-private fields — there is no `em.getKnex()` to extract a usable raw connection. Streaming COPY / BulkLoad therefore need a caller-managed driver resource (a `pg.Pool` or a tedious connection factory), typically the same pool MikroORM was initialised with.

```ts
interface IMikroBulkInsertStrategy {
  execute(ctx: IMikroBulkInsertContext): Promise<number>
}

interface IMikroBulkInsertContext {
  kysely: Kysely<any>          // bound to current scope (transactional in `scope.transaction()`)
  isInTransaction: boolean     // strategies use this to choose fallback
  table: string
  stream: PassThrough & AsyncIterable<Record<string, unknown>>  // post-mapper, keyed by entity props
  objectToDBmapping: Record<string, string>                     // entity prop → DB column
}
```

| Strategy | Mechanism | Resources |
|---|---|---|
| `KyselyChunkedBulkInsertStrategy` | Chunked multi-row INSERT via Kysely (default). Participates in MikroORM transactions. | none |
| `PostgresCopyBulkInsertStrategy` | Streaming `COPY ... FROM STDIN` via `pg-copy-streams`. | `pool: pg.Pool` |
| `MssqlBulkLoadBulkInsertStrategy` | TDS `BulkLoad` (BCP) via tedious. Schema discovered through Kysely (`KyselyMssqlSchemaInspector`). | `factory: ITediousConnectionFactory` |

```ts
function resolveMikroBulkInsertStrategy(deps: {
  kysely: Kysely<any>                       // pass em.getKysely()
  dialect?: 'postgres' | 'mssql' | 'mysql' | 'sqlite' | 'unknown'  // override auto-detect
  pgPool?: IPgPoolLike                      // PG COPY path
  mssqlFactory?: ITediousConnectionFactory  // MSSQL BulkLoad path
  fallbackBatchSize?: number
}): IMikroBulkInsertStrategy
```

Selection rules:
- `postgres` + `pgPool` → `PostgresCopyBulkInsertStrategy`
- `mssql` + `mssqlFactory` → `MssqlBulkLoadBulkInsertStrategy`
- everything else → `KyselyChunkedBulkInsertStrategy`

`detectKyselyDialect(kysely)` is exported separately if you need just the dialect; it reads `kysely.getExecutor().adapter.constructor.name`.

**Transaction semantics** — `PostgresCopyBulkInsertStrategy` and `MssqlBulkLoadBulkInsertStrategy` cannot run inside a MikroORM transaction (Kysely owns the transactional connection and won't release it externally). When `ctx.isInTransaction` is true they transparently fall back to `KyselyChunkedBulkInsertStrategy`, which IS in the transaction, so commit/rollback still work — just slower than the native path. Pass `fallbackInTransaction: false` to the strategy options to throw instead.

### PostgresCopyBulkInsertStrategy

```ts
new PostgresCopyBulkInsertStrategy({
  pool: IPgPoolLike,                    // typically the same pg.Pool MikroORM uses
  fallbackInTransaction?: boolean,      // default true (silent fallback to chunked)
  fallbackBatchSize?: number,           // default 1000
})
```

CSV escaping mirrors the knex-side strategy: `\t` delimiter, JSON-stringified objects, ISO Date strings, `null` for missing keys.

### MssqlBulkLoadBulkInsertStrategy

```ts
new MssqlBulkLoadBulkInsertStrategy({
  factory: ITediousConnectionFactory,   // user-managed tedious connection lifecycle
  inspector?: IMssqlSchemaInspector,    // default: KyselyMssqlSchemaInspector(ctx.kysely)
  timeout?: number,
  bulkOptions?: { checkConstraints?, fireTriggers?, keepNulls?, lockTable?, order? },
  cacheSchema?: boolean,                // default true
  fallbackInTransaction?: boolean,      // default true
  fallbackBatchSize?: number,
})

interface ITediousConnectionFactory {
  acquire(): Promise<ITediousConnection>
  release(conn: ITediousConnection, err?: unknown): void | Promise<void>  // err is non-null on BulkLoad failure
}
```

A "fresh connection per call" factory is fine; the strategy passes a non-null `err` to `release()` when the BulkLoad fails so the caller can drop the connection rather than return it to a pool.

Behavior matches the knex-side `MssqlBulkInsertStrategy`:
- Identity / computed columns silently dropped from `objectToDBmapping`.
- Case-insensitive column matching; canonical schema-cased name sent to BulkLoad.
- Empty streams short-circuit (peek before acquire).
- Connection error is handed back to `factory.release(conn, err)` so the caller can poison it.
- Value coercion: `Buffer` / `ArrayBuffer` views pass through; plain objects → `JSON.stringify`; `Date` passes through; missing keys → `null`.
- Schema-qualified names supported (`dbo.MyTable`, `[dbo].[MyTable]`); `OBJECT_ID()` resolution failures throw with a clear message.

### KyselyMssqlSchemaInspector

Standalone reusable inspector. Runs the same `information_schema.columns` + `sys.columns` queries as the knex inspector, but through Kysely:

```ts
new KyselyMssqlSchemaInspector(kysely).inspect('dbo.MyTable')
// → IMssqlColumnDescriptor[]
```

---

## 4. Cloner (deep clone)

Facade with pluggable strategy. Construct with a strategy or use the shared singleton.

```ts
class Cloner {
  constructor(cloner?: ICloner)               // default: StructuredCloner
  static getInstance(): Cloner                // shared instance (StructuredCloner)
  static isCloneable(obj: unknown): boolean   // false for streams, WeakMap, WeakSet, functions
  /** @deprecated — construct `new Cloner(strategy)` instead of mutating the shared instance */
  setCloner(cloner: ICloner): void
  clone<T>(data: T): T                        // branded ICloneable.clone() if present, else strategy
}

interface ICloner { clone<T>(data: T): T }

const CLONEABLE: unique symbol               // Symbol.for('@cleverjs/toolkit:cloneable')
interface ICloneable {
  readonly [CLONEABLE]: true                 // explicit opt-in brand — a bare clone() method is not detected
  clone(nextData?: any): this
}
```

Built-in strategies (all exported):
- **`StructuredCloner`** (default) — uses native `structuredClone()`.
- **`JSONCloner`** — `JSON.parse(JSON.stringify())` with Date/Buffer restoration.

---

## 5. Paginator

```ts
class Paginator {
  constructor(options?: { page?: number; perPage?: number; skipTotal?: boolean })
  // page defaults to 1 (1-indexed), perPage defaults to 10

  getPage(): number
  getPerPage(): number
  getLimit(): number           // alias for getPerPage()
  getOffset(): number          // perPage * (page - 1)
  getTotal(): number
  setTotal(total: number): void
  isSkipTotal(): boolean
  getPageCount(): number       // ceil(total / perPage)
}
```

---

## 6. listWithPagination helper

Runs `findAll` and `count` in parallel, sets paginator total automatically.

```ts
async function listWithPagination<DomainEntity>(
  repository: IRepository<DomainEntity>,
  paginator: Paginator,
  condition?: Condition,
  sort?: ISort
): Promise<{ items: DomainEntity[]; total: number }>
```

Skips `count` call when `paginator.getTotal() > 0` or `paginator.isSkipTotal()`. When the count is skipped, a total cached on the paginator (from a previous call) is returned and preserved; `-1` is returned only when the total is genuinely unknown (`skipTotal`).

---

## 7. Utility functions

### Object helpers (`@cleverjs/toolkit` and `@cleverjs/toolkit/objects`)

```ts
removeNullish<T>(obj: T): Partial<T>         // strips null and undefined values
removeUndefined<T>(obj: T): Partial<T>       // strips only undefined (keeps null)
getKeyByValue<T>(enumObj: T, value): keyof T | null  // reverse enum lookup
isEmptyObject(obj): boolean                   // recursive; { a: null } → true; class instances (Date, Map, ...) are opaque values → non-empty
intersect(setA: Set, setB: Set): Set          // set intersection
```

### Type guards

```ts
isInstanceOf<T>(obj, condition: string | ((o) => boolean)): obj is T
isInstanceOfByCondition<T>(obj, condition: (o) => boolean): obj is T
isExactInstanceOf<T>(e, cls: TClass<T>): e is T   // instanceof + constructor check
```

### Converters

```ts
convertToBoolean(v: any): boolean
// null/undefined → false
// boolean → identity
// number → 0 false, 1 true (else throws)
// string (case-insensitive) → 'yes'/'y'/'true'/'t'/'1' → true;
//   'no'/'n'/'false'/'f'/'0'/'null'/'undefined' → false; else throws
```

### Streams

```ts
async function peekAndReplayStream<T>(
  originalStream: Readable
): Promise<{ first: T; replayStream: PassThrough }>
// Reads first chunk, returns it + full replay stream (including that chunk).
// Throws 'Stream is empty' or 'Stream does not support async iteration'.
```

### Type utilities

```ts
type TClass<T = object> = new (...args: any[]) => T
type PropertySchema<T> = { /* data-only keys of T (strips methods) */ }
```

---

## 8. End-to-end usage example

```ts
import { Condition, ConditionAdapterRegistry } from '@cleverjs/condition-builder'
import { FieldMapper, Paginator, listWithPagination } from '@cleverjs/toolkit'
import { KnexConnectionScope, KnexRepository } from '@cleverjs/toolkit/knex'
import Knex from 'knex'

// 1. Define domain entity
interface User {
  id: number
  email: string
  name: string
}

// 2. Define DB entity (matches table columns)
interface UserRow {
  id: number
  email: string
  full_name: string
}

// 3. Create mapper (only differing fields need listing)
const mapper = new FieldMapper<User, UserRow>({ name: 'full_name' })

// 4. Create scope and repository
const knex = Knex({ client: 'pg', connection: '...' })
const scope = new KnexConnectionScope(knex)
const conditionRegistry = new ConditionAdapterRegistry()
const repo = new KnexRepository<UserRow, User, 'id'>(scope, mapper, {
  table: 'users',
  primary: ['id'],
  conditionRegistry,
})

// 5. Query
const condition = new Condition({ email: Condition.EQ, value: 'test@example.com' })
const user = await repo.findOne(condition)

// 6. Paginated list
const paginator = new Paginator({ page: 1, perPage: 20 })
const { items, total } = await listWithPagination(repo, paginator, undefined, { id: 'asc' })

// 7. Transaction
await scope.transaction(async () => {
  await repo.insert({ email: 'new@example.com', name: 'New User' })
  await repo.update(condition, { name: 'Updated' })
})
```

---

## Peer dependencies (all optional)

| Dependency | Required for |
|---|---|
| `@cleverjs/condition-builder` | Condition-based queries in repositories. Register `KyselyConditionAdapter` (`AdapterType.KYSELY`) for `MikroRepository.stream()`. |
| `@mikro-orm/core` (v7+) | `MikroRepository`, `MikroConnectionScope` |
| `@mikro-orm/decorators` | Optional. Only if you choose decorator-based entities instead of the recommended `defineEntity()` from `@mikro-orm/core`. `/legacy` = TS experimental (needs `reflect-metadata`); `/es` = stage-3 standard. |
| `kysely` | Runtime query builder used by MikroORM v7 and by the Mikro-side bulk insert strategies |
| `knex` | `KnexRepository`, `KnexConnectionScope`, knex-side bulk insert strategies |
| `pg` | PostgreSQL driver — shared between MikroORM (via `new PostgresDialect({ pool })`) and `PostgresCopyBulkInsertStrategy` |
| `pg-copy-streams` | `PostgresBulkInsertStrategy` (knex) / `PostgresCopyBulkInsertStrategy` (Mikro) |
| `tedious` | MSSQL driver — `MssqlBulkInsertStrategy` (knex) and `MssqlBulkLoadBulkInsertStrategy` (Mikro) |
