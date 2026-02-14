# @cleverjs/toolkit

A TypeScript infrastructure toolkit for building backend applications with swappable repository implementations. Decouple your business logic from any specific ORM or query builder — switch between Knex, MikroORM, Prisma, or anything else without touching your services.

## Why

Backend applications accumulate infrastructure concerns that are tedious to build correctly every time: transaction propagation, domain/DB entity mapping, high-volume bulk inserts, paginated listing. This toolkit solves these problems once.

**What you get:**

- **Connection scoping** — `AsyncLocalStorage`-based transaction propagation. No passing `trx` through every function; nested calls automatically become savepoints.
- **Repository + Mapper pattern** — generic CRUD interface (`IRepository`) with clean separation between domain models (camelCase) and database entities (snake_case). Your services depend on the interface, not the ORM.
- **Swappable implementations** — `KnexRepository` and `MikroRepository` implement the same interface. Switch between Knex, MikroORM, or your own implementation without touching business logic.
- **Bulk insert strategies** — PostgreSQL `COPY FROM STDIN` for high-volume loading, batched `INSERT` fallback, extensible per database.
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

**For MikroORM repositories:**

```bash
pnpm add @cleverjs/condition-builder @mikro-orm/core @mikro-orm/knex
```

**For PostgreSQL bulk insert (COPY):**

```bash
pnpm add pg pg-copy-streams
```

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

The condition builder is what makes `IRepository` truly ORM-independent: your services build conditions using domain field names, and each repository implementation serializes them to its native query format.

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
│   └── bulk-insert/            # Bulk insert strategies
│       ├── IBulkInsertStrategy.ts
│       ├── PostgresBulkInsertStrategy.ts
│       ├── FallbackBulkInsertStrategy.ts
│       └── BulkInsertStrategyRegistry.ts
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
  findAll(payload?: IFindAll): Promise<DomainEntity[]>
  findPartial<R>(payload: IFindAllWithSelect): Promise<R[]>
  count(condition?: Condition): Promise<number>
  insert(data: Omit<DomainEntity, PrimaryKey>): Promise<DomainEntity>
  updateOne(condition: Condition, data: Partial<...>): Promise<DomainEntity>
  update(condition: Condition, data: Partial<...>): Promise<number>
  delete(condition: Condition): Promise<number>
  insertMany(items: Omit<DomainEntity, PrimaryKey>[]): Promise<...>
  bulkInsert(stream: PassThrough & AsyncIterable<DomainEntity>): Promise<number>
  stream<R>(payload: IFindAllWithSelect): PassThrough & AsyncIterable<R>
}
```

`IMapper<DomainEntity, DBEntity>` separates your domain models from database entities:

```typescript
interface IMapper<DomainEntity, DBEntity> {
  toDomain(entity: DBEntity): DomainEntity
  toEntity(data: DomainEntity): DBEntity
  toPersistence(domain: Partial<PropertySchema<DomainEntity>>): Partial<DBEntity>
}
```

**Example — defining a domain model, DB entity, and mapper:**

```typescript
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
}
```

**Creating a repository — Knex:**

```typescript
import { KnexConnectionScope, KnexRepository } from '@cleverjs/toolkit'
import knex from 'knex'

const db = knex({ client: 'pg', connection: '...' })
const scope = new KnexConnectionScope(db)
const userRepo = new KnexRepository<UserDBEntity, User>(scope, new UserMapper(), {
  table: 'users',
  primary: ['email'],
})
```

**Creating a repository — MikroORM:**

```typescript
import { MikroConnectionScope, MikroRepository } from '@cleverjs/toolkit'

const em = orm.em.fork()
const scope = new MikroConnectionScope(em)
const userRepo = new MikroRepository<UserEntity, User>(scope, UserEntity, new UserMapper())
```

**Using the repository in a service (ORM-agnostic):**

```typescript
class UserService {
  constructor(private readonly repo: IRepository<User>) {}

  async getActiveUsers(paginator: Paginator): Promise<User[]> {
    const condition = ConditionBuilder.create({ is_active: true }).build()
    return this.repo.findAll({ condition, paginator, sort: { name: 'asc' } })
  }
}
```

The service depends only on `IRepository<User>` — it doesn't know or care whether it's backed by Knex or MikroORM.

> **Note:** Condition field names and sort keys use **database column names** (snake_case), not domain field names. The mapper handles conversion for insert/update data, but conditions and sort are passed directly to the query builder.

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

For high-volume data loading, the toolkit provides database-specific bulk insert strategies. Both repository implementations call `bulkInsert()` on the `IRepository` interface.

**Creating a stream and calling bulkInsert:**

```typescript
import { PassThrough } from 'stream'

// Create an object-mode stream of domain entities
const stream = new PassThrough({ objectMode: true })
for (const item of largeDataset) {
  stream.write(item)
}
stream.end()

const rowCount = await repository.bulkInsert(stream)
```

**How strategies are selected:**

- **MikroRepository** uses `BulkInsertStrategyRegistry` to auto-detect the database. For PostgreSQL it selects `PostgresBulkInsertStrategy` (uses `COPY FROM STDIN`); for other databases it falls back to `FallbackBulkInsertStrategy` (batched `INSERT` statements).
- **KnexRepository** uses the `bulkInsertStrategy` from its config, defaulting to `FallbackBulkInsertStrategy`. To use PostgreSQL COPY with Knex, pass the strategy explicitly:

```typescript
import { PostgresBulkInsertStrategy } from '@cleverjs/toolkit'

const userRepo = new KnexRepository<UserDBEntity, User>(scope, mapper, {
  table: 'users',
  primary: ['email'],
  bulkInsertStrategy: new PostgresBulkInsertStrategy(),
})
```

You can register custom strategies for other databases:

```typescript
const registry = BulkInsertStrategyRegistry.getInstance()
registry.registerStrategy(new MySQLBulkInsertStrategy())
```

> **Note:** `bulkInsert()` participates in transactions normally — both PostgreSQL `COPY` and batched `INSERT` strategies respect `scope.transaction()`. If the transaction rolls back, the bulk-inserted rows are discarded.

### Listing with Pagination

`listWithPagination` runs `findAll` and `count` in parallel:

```typescript
import { listWithPagination, Paginator } from '@cleverjs/toolkit'

const paginator = new Paginator({ page: 2, perPage: 20 })
const { items, total } = await listWithPagination(userRepo, paginator, condition, { name: 'asc' })
```

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

Deep cloning with strategy pattern. Default strategy uses `structuredClone()`. Supports custom clone logic via `ICloneable` interface.

```typescript
import { Cloner } from '@cleverjs/toolkit'

const cloner = Cloner.getInstance()
const copy = cloner.clone({ nested: { date: new Date(), set: new Set([1, 2]) } })

// Custom clone behavior for your classes
import { ICloneable } from '@cleverjs/toolkit'

class MyEntity implements ICloneable {
  clone() {
    return new MyEntity(/* custom logic */)
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
intersect(new Set([1, 2]), new Set([2, 3]))        // Set { 2 }
```

### Other Utilities

```typescript
import { peekAndReplayStream, convertToBoolean, KnexHelper } from '@cleverjs/toolkit'

// Peek at first item of a stream without consuming it
const { first, replayStream } = await peekAndReplayStream(sourceStream)

// Parse boolean from various formats
convertToBoolean('yes')   // true
convertToBoolean('0')     // false
convertToBoolean(1)       // true

// Extract the underlying Knex instance from a MikroORM EntityManager
const knex = KnexHelper.getKnex(em)
```

Also exported: `getKeyByValue`, `TClass`, `PropertySchema`, and type guard helpers (`isInstanceOf`, `isExactInstanceOf`) via `@cleverjs/toolkit`.

## Export Subpaths

| Subpath | Contents |
|---|---|
| `@cleverjs/toolkit` | Everything — repositories, scope, bulk insert, utilities |
| `@cleverjs/toolkit/objects` | Object helpers only (`removeNullish`, `removeUndefined`, etc.) |

## License

MIT
