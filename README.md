# @cleverjs/core-toolkit

A TypeScript toolkit providing utilities, repository patterns, and helpers for building applications.

## Installation

```bash
npm install @cleverjs/core-toolkit
# or
pnpm add @cleverjs/core-toolkit
```

## Peer Dependencies

This package has **optional peer dependencies** - you only need to install the ones required for the features you use:

### For Utilities Only (Cloner, Paginator, Helpers, Type Guards)
No additional dependencies required! ✨

```typescript
import { Cloner, Paginator, removeNullish, isEmptyObject } from '@cleverjs/core-toolkit'
```

### For MikroORM Repository Pattern
Install these peer dependencies:

```bash
npm install @cleverjs/condition-builder @mikro-orm/core @mikro-orm/knex
```

```typescript
import { MikroRepository, AbstractApplicationService } from '@cleverjs/core-toolkit'
```

### For PostgreSQL Bulk Insert
Install these additional peer dependencies:

```bash
npm install pg pg-copy-streams
```

```typescript
import { PostgresBulkInsertStrategy } from '@cleverjs/core-toolkit'
```

## Features

### 🔧 Utilities
- **Cloner**: Deep cloning with V8 and JSON strategies
- **Paginator**: Pagination helper
- **Object Helpers**: `removeNullish`, `removeUndefined`, `getKeyByValue`, `isEmptyObject`, `intersect`
- **Stream Helpers**: `peekAndReplayStream`
- **Type Guards**: Runtime type checking utilities
- **Converters**: `convertToBoolean`

### 🗄️ Repository Pattern (requires MikroORM)
- **MikroRepository**: Generic repository implementation for MikroORM
- **AbstractApplicationService**: Base service class with condition building
- **KnexHelper**: Knex query builder utilities

### ⚡ Bulk Insert Strategies (requires MikroORM)
- **PostgresBulkInsertStrategy**: Optimized PostgreSQL COPY command (requires `pg` + `pg-copy-streams`)
- **FallbackBulkInsertStrategy**: Standard batch inserts for any database
- **BulkInsertStrategyRegistry**: Strategy pattern registry

## Usage Examples

### Using Utilities (No Dependencies Required)

```typescript
import { Cloner, Paginator, removeNullish } from '@cleverjs/core-toolkit'

// Deep clone objects
const cloner = new Cloner()
const cloned = cloner.clone(originalObject)

// Pagination
const paginator = new Paginator({ page: 1, limit: 10 })

// Object helpers
const cleaned = removeNullish({ a: 1, b: null, c: undefined })
// Result: { a: 1 }
```

### Using MikroRepository (Requires MikroORM)

```typescript
import { MikroRepository } from '@cleverjs/core-toolkit'
import { EntityManager } from '@mikro-orm/core'

class UserRepository extends MikroRepository<UserEntity, User> {
  constructor(em: EntityManager) {
    super(em.getRepository(UserEntity), new UserMapper())
  }
}
```
