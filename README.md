# @cleverjs/toolkit

A TypeScript infrastructure toolkit for building backend applications with swappable repository implementations. Decouple your business logic from any specific ORM or query builder — switch between Knex, MikroORM, Prisma, or anything else without touching your services.

## Why

Backend applications accumulate infrastructure concerns that are tedious to build correctly every time: transaction propagation, domain/DB entity mapping, high-volume bulk inserts, paginated listing. This toolkit solves these problems once.

**What you get:**

- **Connection scoping** — `AsyncLocalStorage`-based transaction propagation. No passing `trx` through every function; nested calls automatically become savepoints.
- **Repository + Mapper pattern** — generic CRUD interface (`IRepository`) with clean separation between domain models (camelCase) and database entities (snake_case). Your services depend on the interface, not the ORM.
- **Swappable implementations** — `KnexRepository` and `MikroRepository` implement the same interface. Switch between Knex, MikroORM, or your own implementation without touching business logic.
- **Bulk insert strategies** — PostgreSQL `COPY FROM STDIN` and SQL Server `BulkLoad` (TDS BCP) for high-volume loading, batched `INSERT` fallback, extensible per database.
- **Utilities** — pagination, deep cloning, stream helpers, object manipulation.

## Installation

```bash
pnpm add @cleverjs/toolkit
```

### Peer Dependencies

All peer dependencies are **optional** — install only what you need. This enables tree-shaking so projects using only utilities don't pull in ORM packages.

**For Knex repositories:**

```bash
pnpm add @cleverjs/condition-builder knex pg
```

**For MikroORM repositories (v7+):**

```bash
pnpm add @cleverjs/condition-builder @mikro-orm/core kysely
```

Entities are recommended to be declared via the `defineEntity()` builder from `@mikro-orm/core` — it's the path MikroORM v7 recommends for new projects, needs no `reflect-metadata`, no tsconfig decorator flags, and is fully type-inferred. If you prefer decorators, install `@mikro-orm/decorators` separately and import from `/legacy` (TypeScript experimental, needs `reflect-metadata` + `metadataProvider: ReflectMetadataProvider`) or `/es` (stage-3 standard).

> **MikroORM v6 users:** v7 replaces Knex with Kysely under the hood. `em.getKnex()` is gone — use `em.getKysely()`. `@mikro-orm/knex` no longer exists as a separate package. See [`MikroORM 7 release notes`](https://mikro-orm.io/blog/mikro-orm-7-released).

**For PostgreSQL bulk insert (streaming COPY):**

```bash
pnpm add pg pg-copy-streams
```

The Mikro-side `PostgresCopyBulkInsertStrategy` takes a `pg.Pool` directly so the same pool can be shared with MikroORM via `driverOptions: new PostgresDialect({ pool })`.

**For SQL Server bulk insert (TDS BulkLoad):**

```bash
pnpm add tedious
```

The Mikro-side `MssqlBulkLoadBulkInsertStrategy` takes a caller-managed `ITediousConnectionFactory`; you control connection lifecycle (pool or per-call).

**For utilities only (Cloner, Paginator, helpers):**

No additional dependencies required.

### Condition Builder

All repository query methods accept a `Condition` object from [`@cleverjs/condition-builder`](https://www.npmjs.com/package/@cleverjs/condition-builder) — a separate package that builds WHERE clauses for both Knex and MikroORM from the same input:

```typescript
import { Condition, ConditionBuilder } from '@cleverjs/condition-builder'

// Simple equality
const condition = ConditionBuilder.create({ name: 'Alice', age: 30 }).build()

// The condition is ORM-agnostic — repositories serialize it for their specific adapter
await repository.findAll({ condition })
```

The condition builder is what makes `IRepository` truly ORM-independent: your services build conditions once, and each repository implementation serializes them to its native query format.

> **Note:** When a mapper with field mapping is used (e.g. `FieldMapper`, `MikroFieldMapper`), condition field names, sort keys, and select fields accept **domain field names** (e.g. `isActive` instead of `is_active`). The repository automatically translates them to DB column names using the mapper's `getFieldMapping()`. Fields not in the mapping pass through unchanged.

## Architecture

```
src/
├── infrastructure/
│   ├── IRepository.ts          # Generic repository interface
│   ├── Knex.repository.ts      # Knex implementation
│   ├── Mikro.repository.ts     # MikroORM implementation
│   ├── scope/                  # Transaction scoping (AsyncLocalStorage)
│   │   ├── IConnectionScope.ts
│   │   ├── KnexConnectionScope.ts
│   │   └── MikroConnectionScope.ts
│   ├── mapper/                 # Built-in mapper implementations
│   │   ├── IdentityMapper.ts
│   │   ├── FieldMapper.ts
│   │   ├── MikroIdentityMapper.ts
│   │   └── MikroFieldMapper.ts
│   └── bulk-insert/                # Bulk insert strategies
│       ├── IBulkInsertStrategy.ts          # KnexRepository side
│       ├── resolveBulkInsertStrategy.ts
│       ├── knex/                           # used by KnexRepository
│       │   ├── PostgresBulkInsertStrategy.ts
│       │   ├── FallbackBulkInsertStrategy.ts
│       │   ├── MssqlBulkInsertStrategy.ts
│       │   └── mssql/
│       │       ├── MssqlSchemaInspector.ts
│       │       └── sqlTypeMap.ts
│       └── mikro/                          # Kysely-based (used by MikroRepository, v7+)
│           ├── IMikroBulkInsertStrategy.ts
│           ├── KyselyChunkedBulkInsertStrategy.ts
│           ├── PostgresCopyBulkInsertStrategy.ts
│           ├── MssqlBulkLoadBulkInsertStrategy.ts
│           ├── KyselyMssqlSchemaInspector.ts
│           ├── detectKyselyDialect.ts
│           └── resolveMikroBulkInsertStrategy.ts
└── utils/
    ├── Paginator.ts
    ├── list-with-pagination.ts
    └── clone/                  # Deep cloning with strategy pattern
```

## Core Concepts

### Repository + Mapper

`IRepository<DomainEntity, PrimaryKey>` is the interface your services depend on. It provides standard CRUD operations:

```typescript
interface IRepository<DomainEntity, PrimaryKey extends keyof DomainEntity = never> {
  findOne(condition: Condition): Promise<DomainEntity | null>
  findById(id: TPrimaryKeyPayload): Promise<DomainEntity | null>
  findAll(payload?: IFindAll): Promise<DomainEntity[]>
  findPartial<R>(payload: IFindAllWithSelect): Promise<R[]>
  count(condition?: Condition): Promise<number>
  insert(data: Omit<DomainEntity, PrimaryKey>): Promise<DomainEntity>
  updateOne(condition: Condition, data: Partial<...>): Promise<DomainEntity>
  updateById(id: TPrimaryKeyPayload, data: Partial<...>): Promise<DomainEntity>
  update(condition: Condition, data: Partial<...>): Promise<number>
  delete(condition: Condition): Promise<number>
  deleteById(id: TPrimaryKeyPayload): Promise<number>
  insertMany(items: Omit<DomainEntity, PrimaryKey>[]): Promise<...>
  bulkInsert(stream: PassThrough & AsyncIterable<DomainEntity>): Promise<number>
  stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R>
}
```

**Primary-key shortcuts.** `findById`, `updateById`, and `deleteById` are sugar over `findOne`/`updateOne`/`delete` with a condition built from the repository's primary key — no `ConditionBuilder.create({ id }).build()` boilerplate:

```typescript
const user = await repository.findById(42)
await repository.updateById(42, { name: 'New name' })
const deleted = await repository.deleteById(42) // 0 or 1

// Composite primary key: pass one value per key column.
// Keys must match `repository.primary` exactly (DB-side names).
await orderItems.findById({ orderId: 1, productId: 2 })
```

They throw (never fall back to a broader filter) when the repository has no primary key configured, the id is `null`/`undefined`, a composite key gets a scalar, or the object payload misses a key column / contains extra keys — so a bad payload can never make `deleteById` touch rows it didn't target. The underlying helper is exported as `buildPrimaryKeyCondition(primary, id)` for custom `IRepository` implementations.

`IMapper<DomainEntity, DBEntity>` separates your domain models from database entities. `PropertySchema<T>` is a utility type that strips methods from `T`, keeping only data properties.

> **KnexRepository dialect note.** `insert` and `updateOne` use `INSERT/UPDATE ... RETURNING` where the dialect supports it (PostgreSQL, MSSQL). On dialects without RETURNING (e.g. MySQL) they transparently **re-fetch** the row with one extra SELECT, so the returned entity still reflects DB defaults and triggers. The inserted row is identified by the primary-key values from the payload when present; otherwise by the driver-reported `insertId` — trusted only on the MySQL family, for a single-column primary key, and when the value is a positive integer (MySQL reports `0` when the table has no auto-increment column). If neither identifies the row, a descriptive error is thrown — configure `primary` in the repository config.
>
> `updateOne` runs a SELECT followed by an UPDATE; if the row is deleted in between it throws `Entity to update was deleted concurrently`. Wrap the call in `scope.transaction()` when the race must be prevented rather than detected.

```typescript
interface IMapper<DomainEntity, DBEntity> {
  toDomain(entity: DBEntity): DomainEntity
  toEntity(data: DomainEntity): DBEntity
  toPersistence(domain: Partial<PropertySchema<DomainEntity>>): Partial<DBEntity>
  getFieldMapping(): Record<string, string> | undefined
}
```

`getFieldMapping()` returns a `Record<domainField, dbField>` when the mapper renames fields, or `undefined` for identity mappers. Repositories use this to translate sort keys, select fields, and condition field names from domain to DB column names automatically.

**Example — defining a domain model, DB entity, and mapper:**

```typescript
import { IMapper, PropertySchema } from '@cleverjs/toolkit'

// Domain model — what your services work with
interface User {
  email: string
  name: string
  age: number
  isActive: boolean
  createdAt: Date
}

// DB entity — what the database stores
interface UserDBEntity {
  email: string
  name: string
  age: number
  is_active: boolean
  created_at: Date
}

// Mapper — converts between the two
class UserMapper implements IMapper<User, UserDBEntity> {
  toDomain(entity: UserDBEntity): User {
    return {
      email: entity.email,
      name: entity.name,
      age: entity.age,
      isActive: entity.is_active,
      createdAt: entity.created_at,
    }
  }

  toEntity(data: User): UserDBEntity {
    return {
      email: data.email,
      name: data.name,
      age: data.age,
      is_active: data.isActive,
      created_at: data.createdAt,
    }
  }

  toPersistence(domain: Partial<PropertySchema<User>>): Partial<UserDBEntity> {
    const entity: Partial<UserDBEntity> = {}
    if (domain.name !== undefined) entity.name = domain.name
    if (domain.age !== undefined) entity.age = domain.age
    if (domain.isActive !== undefined) entity.is_active = domain.isActive
    return entity
  }

  getFieldMapping(): Record<string, string> | undefined {
    return { isActive: 'is_active', createdAt: 'created_at' }
  }
}
```

### Built-in Mappers

For most cases you don't need a hand-written mapper. The toolkit provides four built-in implementations:

| Mapper | Use case |
|---|---|
| `IdentityMapper<Entity>` | Knex — domain and DB shapes are identical |
| `FieldMapper<Domain, DBEntity>` | Knex — domain and DB have different field names |
| `MikroIdentityMapper<Domain, DBEntity>` | MikroORM — same field names, produces class instances |
| `MikroFieldMapper<Domain, DBEntity>` | MikroORM — different field names, produces class instances |

**Knex — same field names (identity mapping):**

```typescript
import { IdentityMapper } from '@cleverjs/toolkit'

const mapper = new IdentityMapper<User>()

// Optionally restrict which fields are mapped
const mapper = new IdentityMapper<User>(['email', 'name', 'age'])
```

**Knex — different field names:**

```typescript
import { FieldMapper } from '@cleverjs/toolkit'

// Keys are domain field names, values are DB column names.
// Only differing fields need to be listed — matching names pass through automatically.
const mapper = new FieldMapper<User, UserDBEntity>({
  isActive: 'is_active',
  createdAt: 'created_at',
})
```

**MikroORM — same field names:**

MikroORM's identity map and change tracking require entity class instances, not plain objects. The `Mikro*` mappers call `new EntityClass()` + `Object.assign()` in `toEntity()` to satisfy this. That's why they take two type parameters (`Domain` and `DBEntity`) even when field names match — the domain is a plain interface while the DB entity is a class extending `BaseEntity`:

```typescript
import { MikroIdentityMapper } from '@cleverjs/toolkit'

const mapper = new MikroIdentityMapper<User, UserEntity>(UserEntity)
```

**MikroORM — different field names:**

```typescript
import { MikroFieldMapper } from '@cleverjs/toolkit'

const mapper = new MikroFieldMapper<User, UserEntity>(UserEntity, {
  isActive: 'is_active',
  createdAt: 'created_at',
})
```

You can always implement `IMapper` directly for complex transformations (computed fields, nested objects, etc.) — the built-in mappers cover the common case of flat field renaming.

**Creating a repository — Knex:**

```typescript
import { FieldMapper } from '@cleverjs/toolkit'
import { KnexConnectionScope, KnexRepository } from '@cleverjs/toolkit/knex'
import { ConditionAdapterRegistry } from '@cleverjs/condition-builder'
import knex from 'knex'

const db = knex({ client: 'pg', connection: '...' })
const scope = new KnexConnectionScope(db)
const mapper = new FieldMapper<User, UserDBEntity>({ isActive: 'is_active', createdAt: 'created_at' })
const conditionRegistry = new ConditionAdapterRegistry()
const userRepo = new KnexRepository<UserDBEntity, User>(scope, mapper, {
  table: 'users',
  primary: ['email'],
  conditionRegistry,
})
```

**Creating a repository — MikroORM (v7):**

```typescript
import { MikroIdentityMapper } from '@cleverjs/toolkit'
import { MikroConnectionScope, MikroRepository } from '@cleverjs/toolkit/mikro'
import { AdapterType, ConditionAdapterRegistry, KyselyConditionAdapter, MikroOrmConditionAdapter } from '@cleverjs/condition-builder'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'

const orm = await MikroORM.init({
  driver: PostgreSqlDriver,
  entities: [UserSchema],
  dbName: 'app',
  host: 'localhost', port: 5432, user: '...', password: '...',
})

const em = orm.em.fork()
const scope = new MikroConnectionScope(em)
const mapper = new MikroIdentityMapper<User, UserEntity>(UserEntity)

const conditionRegistry = new ConditionAdapterRegistry()
conditionRegistry.register(AdapterType.MIKROORM, new MikroOrmConditionAdapter())
conditionRegistry.register(AdapterType.KYSELY, new KyselyConditionAdapter())  // needed for repo.stream()

const userRepo = new MikroRepository<UserEntity, User>(scope, mapper, {
  entityClass: UserEntity,
  conditionRegistry,
})
```

The entity is declared via `defineEntity()` — no decorators, no `reflect-metadata`:

```typescript
import { BaseEntity, defineEntity } from '@mikro-orm/core'

class UserEntity extends BaseEntity {
  id?: number
  name: string = ''
}

const UserSchema = defineEntity({
  class: UserEntity,
  tableName: 'users',
  properties: (p) => ({
    id: p.integer().primary().autoincrement(),
    name: p.string(),
  }),
})
```

Pass `UserSchema` to `MikroORM.init({ entities: [...] })`. Keep using the class (`UserEntity`) wherever the toolkit asks for `entityClass` or a mapper constructor — `defineEntity({ class })` binds metadata to the class.

### Repository Hooks

`IRepositoryHooks<DomainEntity>` provides write lifecycle hooks that run before mapper transformation on all write paths (`insert`, `insertMany`, `updateOne`, `update`, `bulkInsert`). Both `MikroRepository` and `KnexRepository` accept hooks as an optional constructor parameter. Use this for cross-cutting concerns like audit columns, timestamps, or data enrichment.

```typescript
import { IRepositoryHooks } from '@cleverjs/toolkit'

const hooks: IRepositoryHooks<User> = {
  beforeInsert(data) {
    return { ...data, createdAt: new Date(), createdBy: getCurrentUserId() }
  },
  beforeUpdate(data) {
    return { ...data, modifiedAt: new Date(), modifiedBy: getCurrentUserId() }
  },
}

// Works with both repository implementations
const mikroRepo = new MikroRepository<UserEntity, User>(scope, mapper, {
  entityClass: UserEntity,
  conditionRegistry,
  hooks,
})
const knexRepo = new KnexRepository<UserDBEntity, User>(scope, mapper, {
  table: 'users',
  primary: ['email'],
  conditionRegistry,
  hooks,
})
```

Hooks are plain functions — testable in isolation without any ORM infrastructure:

```typescript
it('should stamp createdAt on insert', () => {
  const result = hooks.beforeInsert!({ name: 'Alice' } as User)
  expect(result.createdAt).toBeInstanceOf(Date)
})
```

**Using the repository in a service (ORM-agnostic):**

```typescript
class UserService {
  constructor(private readonly repo: IRepository<User>) {}

  async getActiveUsers(paginator: Paginator): Promise<User[]> {
    const condition = ConditionBuilder.create({ isActive: true }).build()
    return this.repo.findAll({ condition, paginator, sort: { name: 'asc' } })
  }
}
```

The service depends only on `IRepository<User>` — it doesn't know or care whether it's backed by Knex or MikroORM. Conditions and sort use domain field names (`isActive`, not `is_active`).

### Connection Scope (Transactions)

`IConnectionScope` provides transaction management via `AsyncLocalStorage`. Nested calls automatically become savepoints. Services never need to pass transaction objects around.

```typescript
const scope = new KnexConnectionScope(db)

// Everything inside runs in a single transaction
await scope.transaction(async () => {
  await orderRepo.insert({ userId: 1, product: 'Widget', quantity: 2, status: 'pending' })
  await inventoryRepo.update(
    ConditionBuilder.create({ product: 'Widget' }).build(),
    { quantity: currentQuantity - 2 }
  )
  // If anything throws, both operations roll back
})

// Nested transactions become savepoints
await scope.transaction(async () => {
  await doOuterWork()
  await scope.transaction(async () => {
    await doInnerWork() // runs in a savepoint
  })
})
```

Isolation levels are supported:

```typescript
await scope.transaction(async () => { /* ... */ }, { isolationLevel: 'serializable' })
```

### Bulk Insert Strategies

The toolkit has **two parallel families** of bulk insert strategies — one for each repository — because MikroORM v7 dropped Knex in favor of Kysely. Both repositories call `bulkInsert()` on the `IRepository` interface; what differs is how they reach the database driver underneath.

```typescript
import { PassThrough } from 'stream'

const stream = new PassThrough({ objectMode: true })
for (const item of largeDataset) stream.write(item)
stream.end()

const rowCount = await repository.bulkInsert(stream)
```

#### KnexRepository — `resolveBulkInsertStrategy(knex)`

Reads the dialect from `knex.client.config.client`:

| Dialect | Strategy | Mechanism |
|---|---|---|
| `pg` / `postgresql` | `PostgresBulkInsertStrategy` | `COPY ... FROM STDIN` |
| `mssql` / `tedious` | `MssqlBulkInsertStrategy` | TDS `BulkLoad` (BCP); schema auto-discovered |
| anything else | `FallbackBulkInsertStrategy` | Batched `INSERT` (default batch 1000) |

`KnexRepository.bulkInsert()` resolves automatically; override via `IKnexRepositoryConfig.bulkInsertStrategy`. The strategies acquire the raw `pg.Client` / `tedious.Connection` directly from `knex.client.acquireConnection()`.

#### Transaction semantics (Knex side)

Inside `scope.transaction()`, knex hands the strategy the transaction's **pinned** connection (its `acquireConnection()` returns that single connection; `releaseConnection()` is a no-op). The `COPY` / `BulkLoad` therefore runs on the transaction's own session and is **committed or rolled back atomically** with the rest of the transaction — there is no separate auto-committing connection. This makes "snapshot header + bulk rows in one atomic unit" a pure-toolkit operation:

```ts
await scope.transaction(async () => {
  await headerRepo.insert(snapshotHeader)  // normal INSERT on the trx connection
  await rowRepo.bulkInsert(rowStream)      // COPY / BulkLoad on the SAME trx connection
})                                         // both commit together; throw → both roll back
```

> **Caveat — one connection per transaction.** A transaction pins a single connection, so do **not** run `bulkInsert()` concurrently with other repository calls in the same `scope.transaction()` (e.g. inside `Promise.all([...])`) — they would interleave on one connection and corrupt the wire protocol. Await each operation in sequence.
>
> **MSSQL error handling.** When a `BulkLoad` fails *outside* a transaction, the strategy closes the (possibly wire-desynced) tedious connection so the pool drops it. *Inside* a transaction it leaves the connection open and lets the transaction's rollback clean up — closing it would break knex's own rollback.
>
> **Stream error semantics.** If the source stream errors mid-flow, or a row fails serialization (e.g. a circular reference in a JSON column), `bulkInsert()` rejects with that error and the acquired connection is released — nothing hangs and no unhandled `'error'` event escapes. Postgres `COPY` aborts atomically (no partial rows).
>
> **Empty strings (Postgres COPY).** The CSV serializer quotes empty strings, so `''` round-trips as `''` — only `null`/`undefined` become SQL `NULL`.

#### MikroRepository — `resolveMikroBulkInsertStrategy(deps)`

MikroORM v7's Kysely keeps its `pg.Pool` / tedious connections in hash-private fields — there is no `em.getKnex()` to extract a usable raw connection. The Mikro-side strategies therefore take a caller-managed driver resource (a `pg.Pool` you also pass to MikroORM via `driverOptions: new PostgresDialect({ pool })`, or a tedious connection factory).

```typescript
import { Pool } from 'pg'
import { PostgresDialect } from 'kysely'
import { MikroORM } from '@mikro-orm/core'
import { MikroIdentityMapper } from '@cleverjs/toolkit'
import {
  MikroConnectionScope, MikroRepository,
  resolveMikroBulkInsertStrategy,
} from '@cleverjs/toolkit/mikro'

const pgPool = new Pool({ host, port, user, password, database })

const orm = await MikroORM.init({
  driver: PostgreSqlDriver,
  driverOptions: new PostgresDialect({ pool: pgPool }),  // ← share the pool
  dbName: database,
  // ...
})

const repo = new MikroRepository(new MikroConnectionScope(orm.em.fork()), mapper, {
  entityClass: UserEntity,
  conditionRegistry,
  bulkInsertStrategy: resolveMikroBulkInsertStrategy({
    kysely: orm.em.getKysely(),
    pgPool,                                              // ← same pool to the strategy
  }),
})

await repo.bulkInsert(stream)
```

Selection rules (resolver):

| Detected dialect + resource | Strategy | Mechanism |
|---|---|---|
| `postgres` + `pgPool` | `PostgresCopyBulkInsertStrategy` | `COPY ... FROM STDIN` via `pg-copy-streams`, streamed from the shared `pg.Pool` |
| `mssql` + `mssqlFactory` | `MssqlBulkLoadBulkInsertStrategy` | TDS `BulkLoad`; schema discovered through Kysely (`KyselyMssqlSchemaInspector`) |
| anything else | `KyselyChunkedBulkInsertStrategy` (default) | Chunked multi-row `INSERT` via Kysely (default batch 1000) |

Dialect detection reads `kysely.getExecutor().adapter.constructor.name`. Override via the `dialect` field of the resolver deps if needed.

**MSSQL example:**

```typescript
import { Connection } from 'tedious'

const mssqlFactory = {
  acquire: () => new Promise<Connection>((resolve, reject) => {
    const c = new Connection(tediousConfig)
    c.on('connect', err => err ? reject(err) : resolve(c))
    c.connect()
  }),
  release: (c, err) => c.close?.(),  // pass err to skip returning a poisoned conn to a pool
}

const strategy = resolveMikroBulkInsertStrategy({
  kysely: orm.em.getKysely(),
  mssqlFactory,
})
```

#### Transaction semantics (Mikro side)

`KyselyChunkedBulkInsertStrategy` uses the transactional Kysely from the scope and therefore participates in `scope.transaction()` like any other write — rollback discards the inserted rows.

`PostgresCopyBulkInsertStrategy` and `MssqlBulkLoadBulkInsertStrategy` cannot run inside a MikroORM transaction (Kysely holds the transactional connection and won't release it externally). When invoked inside `scope.transaction()`, they **transparently fall back** to `KyselyChunkedBulkInsertStrategy` so commit/rollback still work — just at the chunked-INSERT rate instead of native COPY / BulkLoad speed. Pass `fallbackInTransaction: false` to the strategy options to throw instead of falling back.

```typescript
// Outside scope.transaction() — uses native COPY:
await repo.bulkInsert(millionRowStream)

// Inside scope.transaction() — silently falls back to chunked INSERT (still transactional):
await scope.transaction(async () => {
  await repo.bulkInsert(smallStream)
})
```

### Listing with Pagination

`listWithPagination` runs `findAll` and `count` in parallel:

```typescript
import { listWithPagination, Paginator } from '@cleverjs/toolkit'

const paginator = new Paginator({ page: 2, perPage: 20 })
const { items, total } = await listWithPagination(userRepo, paginator, condition, { name: 'asc' })
```

The `count` query is skipped when the paginator already carries a total (from a previous call) or when `skipTotal` is set. A cached total is returned and preserved; `total` is `-1` only when it is genuinely unknown (`skipTotal`).

> **Important:** `sort` is **required** when using a paginator with `limit > 1`. Without deterministic ordering, paginated results are undefined. Both `findAll` and `findPartial` throw if a paginator is provided without sort. (`findOne` handles this internally by sorting on the primary key.)

## Utilities

### Paginator

Immutable pagination input with constructor-time validation:

```typescript
import { Paginator } from '@cleverjs/toolkit'

const paginator = new Paginator({ page: 1, perPage: 25 })

paginator.getLimit()     // 25
paginator.getOffset()    // 0
paginator.getPage()      // 1
paginator.getPerPage()   // 25

// Total is the only mutable field — set after count query
paginator.setTotal(100)
paginator.getPageCount() // 4

// skipTotal avoids running a COUNT query
const fast = new Paginator({ page: 1, perPage: 25, skipTotal: true })
```

### Cloner

Deep cloning with strategy pattern. Default strategy uses `structuredClone()`; `JSONCloner` (JSON round-trip with Date/Buffer restoration) is available as an alternative. Supports custom clone logic via the `ICloneable` interface.

```typescript
import { Cloner, JSONCloner } from '@cleverjs/toolkit'

const cloner = Cloner.getInstance() // shared instance, StructuredCloner strategy
const copy = cloner.clone({ nested: { date: new Date(), set: new Set([1, 2]) } })

// Need a different strategy? Construct a dedicated instance — don't mutate the
// shared singleton via setCloner() (deprecated), it affects every consumer.
const jsonCloner = new Cloner(new JSONCloner())

// Custom clone behavior for your classes: implement ICloneable and carry the
// CLONEABLE brand. A bare clone() method is intentionally not enough — that
// duck-typing used to hijack third-party objects (knex QueryBuilder, moment, ...)
// whose clone() means something else entirely.
import { CLONEABLE, ICloneable } from '@cleverjs/toolkit'

class MyEntity implements ICloneable {
  readonly [CLONEABLE] = true
  clone(): this {
    return new MyEntity(/* custom logic */) as this
  }
}
```

### Object Helpers

Available via the main export or the `@cleverjs/toolkit/objects` subpath:

```typescript
import { removeNullish, removeUndefined, isEmptyObject, intersect } from '@cleverjs/toolkit'

removeNullish({ a: 1, b: null, c: undefined })   // { a: 1 }
removeUndefined({ a: 1, b: null, c: undefined })  // { a: 1, b: null }
isEmptyObject({ a: null })                         // true (recursively)
isEmptyObject({ a: new Date() })                   // false — class instances are opaque values
intersect(new Set([1, 2]), new Set([2, 3]))        // Set { 2 }
```

### Other Utilities

```typescript
import { peekAndReplayStream, convertToBoolean } from '@cleverjs/toolkit'

// Peek at first item of a stream without consuming it
const { first, replayStream } = await peekAndReplayStream(sourceStream)

// Parse boolean from various formats
convertToBoolean('yes')   // true
convertToBoolean('0')     // false
convertToBoolean(1)       // true
```

> `KnexHelper.getKnex(em)` was removed in the MikroORM v7 migration — `em.getKnex()` no longer exists in v7. Use `em.getKysely()` (or `MikroRepository`'s protected `getKysely()`) for raw query access.

Also exported: `getKeyByValue`, `TClass`, `PropertySchema`, and type guard helpers (`isInstanceOf`, `isExactInstanceOf`) via `@cleverjs/toolkit`.

## Export Subpaths

Engine-bound code is split into per-engine subpaths so each peer dependency stays truly optional — the root entry never `require()`s `@mikro-orm/core`, `knex`, `tedious`, `pg`, `pg-copy-streams`, or `kysely`.

| Subpath | Contents | Required peers |
|---|---|---|
| `@cleverjs/toolkit` | Engine-agnostic: `IRepository`, `IConnectionScope`, `IBulkInsertStrategy` (contract), `FieldMapper`, `IdentityMapper`, `MikroFieldMapper`, `MikroIdentityMapper`, `Paginator`, `Cloner`, helpers, type guards, `listWithPagination` | none |
| `@cleverjs/toolkit/knex` | `KnexRepository`, `KnexConnectionScope`, `PostgresBulkInsertStrategy`, `MssqlBulkInsertStrategy`, `FallbackBulkInsertStrategy`, `MssqlSchemaInspector`, `resolveBulkInsertStrategy`, `resolveTediousDataType` | `knex` (+ `pg`/`pg-copy-streams` for postgres bulk, `tedious` for mssql bulk) |
| `@cleverjs/toolkit/mikro` | `MikroRepository`, `MikroConnectionScope`, `KyselyChunkedBulkInsertStrategy`, `PostgresCopyBulkInsertStrategy`, `MssqlBulkLoadBulkInsertStrategy`, `KyselyMssqlSchemaInspector`, `detectKyselyDialect`, `resolveMikroBulkInsertStrategy` | `@mikro-orm/core`, `kysely` (+ `pg`/`pg-copy-streams` for postgres COPY, `tedious` for mssql BulkLoad) |
| `@cleverjs/toolkit/objects` | Object helpers only (`removeNullish`, `removeUndefined`, etc.) | none |

## License

MIT
