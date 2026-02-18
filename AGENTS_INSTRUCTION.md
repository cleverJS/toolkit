# @cleverjs/toolkit — AI Reference

> Concise API reference for AI assistants. Read this instead of exploring the source tree.

## Package overview

TypeScript library: generic Repository pattern, bulk insert strategies, connection scoping (transactions), deep cloning, pagination, and object helpers. All ORM/DB peer dependencies are optional for tree-shaking.

**Import paths:**

```ts
import { IRepository, KnexRepository, MikroRepository, ... } from '@cleverjs/toolkit'
import { removeNullish, removeUndefined, ... } from '@cleverjs/toolkit/objects'
```

---

## 1. Repository pattern

### IRepository\<DomainEntity, PrimaryKey\>

Generic repository interface. Two implementations: `MikroRepository` (MikroORM) and `KnexRepository` (raw Knex).

```ts
interface IRepository<DomainEntity = any, PrimaryKey extends keyof DomainEntity = never> {
  readonly primary?: string[]

  findOne(condition: Condition): Promise<DomainEntity | null>
  findAll(payload?: IFindAll): Promise<DomainEntity[]>
  findPartial<R = Partial<DomainEntity>>(payload: IFindAllWithSelect): Promise<R[]>
  count(condition?: Condition): Promise<number>
  insert(data: Omit<DomainEntity, PrimaryKey>): Promise<DomainEntity>
  updateOne(condition: Condition, data: Partial<PropertySchema<DomainEntity>>): Promise<DomainEntity>
  update(condition: Condition, data: Partial<PropertySchema<DomainEntity>>): Promise<number>
  delete(condition: Condition): Promise<number>
  insertMany<R = any[]>(items: Omit<DomainEntity, PrimaryKey>[]): Promise<R>
  bulkInsert(stream: PassThrough & AsyncIterable<DomainEntity>): Promise<number>
  stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R>
}
```

**Constraints:**
- `findAll` / `findPartial` / `stream`: when `paginator` is provided with `limit > 1`, `sort` is **required** (throws otherwise).
- `updateOne`: throws if zero or more than one entity matches the condition.

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
  condition?: Condition        // from @cleverJS/condition-builder
  paginator?: Paginator
  sort?: ISort
}
interface IFindAllWithSelect extends IFindAll {
  select?: string[]
}
interface ISort { [field: string]: 'asc' | 'desc' }
```

### MikroRepository

```ts
class MikroRepository<
  DBEntity extends BaseEntity,
  DomainEntity,
  TPrimaryKey extends keyof DomainEntity = never
> implements IRepository<DomainEntity, TPrimaryKey> {
  constructor(
    scope: IConnectionScope<EntityManager>,
    entityClass: EntityName<DBEntity>,
    mapper: IMapper<DomainEntity, DBEntity>
  )
  protected getKnex(): Knex        // access underlying Knex
  protected getTable(): string      // table name from entity metadata
}
```

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
    config: IKnexRepositoryConfig
  )
}

interface IKnexRepositoryConfig {
  table: string
  primary?: string[]
  bulkInsertStrategy?: IBulkInsertStrategy<Knex>
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

```ts
interface IBulkInsertStrategy<TConnection = unknown> {
  execute<T>(
    connection: TConnection,
    stream: PassThrough & AsyncIterable<T>,
    options: { table: string; objectToDBmapping: Record<string, string> }
  ): Promise<number>  // returns row count
}
```

| Strategy | How it works |
|---|---|
| `PostgresBulkInsertStrategy` | PostgreSQL `COPY ... FROM STDIN` (tab-delimited). Highest throughput. |
| `FallbackBulkInsertStrategy` | Batched `INSERT` statements (default batch 1000). Works with any DB. |

Auto-selection:

```ts
function resolveBulkInsertStrategy(knex: Knex): IBulkInsertStrategy<Knex>
// 'pg' / 'postgresql' → PostgresBulkInsertStrategy
// everything else     → FallbackBulkInsertStrategy
```

Repositories resolve the strategy automatically; you only need to care about this if overriding via `IKnexRepositoryConfig.bulkInsertStrategy`.

---

## 4. Cloner (deep clone)

Singleton facade with pluggable strategy.

```ts
class Cloner {
  static getInstance(): Cloner
  static isCloneable(obj: unknown): boolean   // false for streams, WeakMap, WeakSet, functions
  setCloner(cloner: ICloner): void            // swap strategy
  clone<T>(data: T): T                        // ICloneable.clone() if present, else strategy
}

interface ICloner { clone<T>(data: T): T }
interface ICloneable { clone(nextData?: any): this }
```

Built-in strategies:
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

Skips `count` call when `paginator.getTotal() > 0` or `paginator.isSkipTotal()`.

---

## 7. Utility functions

### Object helpers (`@cleverjs/toolkit` and `@cleverjs/toolkit/objects`)

```ts
removeNullish<T>(obj: T): Partial<T>         // strips null and undefined values
removeUndefined<T>(obj: T): Partial<T>       // strips only undefined (keeps null)
getKeyByValue<T>(enumObj: T, value): keyof T | null  // reverse enum lookup
isEmptyObject(obj): boolean                   // recursive; { a: null } → true
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

### KnexHelper

```ts
class KnexHelper {
  static getKnex(em: EntityManager): Knex   // extract Knex from MikroORM EM
}
```

### Type utilities

```ts
type TClass<T = object> = new (...args: any[]) => T
type PropertySchema<T> = { /* data-only keys of T (strips methods) */ }
```

---

## 8. End-to-end usage example

```ts
import { Condition } from '@cleverJS/condition-builder'
import {
  KnexConnectionScope,
  KnexRepository,
  FieldMapper,
  Paginator,
  listWithPagination,
} from '@cleverjs/toolkit'
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
const repo = new KnexRepository<UserRow, User, 'id'>(scope, mapper, {
  table: 'users',
  primary: ['id'],
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
| `@cleverJS/condition-builder` | Condition-based queries in repositories |
| `@mikro-orm/core`, `@mikro-orm/knex` | `MikroRepository`, `MikroConnectionScope` |
| `knex` | `KnexRepository`, `KnexConnectionScope`, bulk insert strategies |
| `pg` | PostgreSQL connection |
| `pg-copy-streams` | `PostgresBulkInsertStrategy` (COPY command) |
