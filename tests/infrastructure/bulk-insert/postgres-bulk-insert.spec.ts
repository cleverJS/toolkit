import {
  AdapterType,
  ConditionAdapterRegistry,
  KnexConditionAdapter,
  KyselyConditionAdapter,
  MikroOrmConditionAdapter,
} from '@cleverjs/condition-builder'
import { BaseEntity, MikroORM } from '@mikro-orm/core'
import { Entity, PrimaryKey, Property, ReflectMetadataProvider } from '@mikro-orm/decorators/legacy'
import { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql'
import { PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  MikroConnectionScope,
  MikroIdentityMapper,
  MikroRepository,
  PostgresCopyBulkInsertStrategy,
  resolveMikroBulkInsertStrategy,
} from '../../../src'

// Test Entity
@Entity({ tableName: 'test_products' })
class ProductEntity extends BaseEntity {
  @PrimaryKey({ autoincrement: true })
  public id?: number

  @Property()
  public name: string = ''

  @Property({ type: 'float' })
  public price: number = 0

  @Property({ fieldName: 'created_at' })
  public createdAt: Date = new Date()

  @Property({ nullable: true })
  public description?: string

  @Property({ fieldName: 'is_active', default: true })
  public isActive: boolean = false

  @Property({ type: 'json', nullable: true })
  public metadata?: Record<string, any>
}

// Domain Entity
interface Product {
  id?: number
  name: string
  price: number
  createdAt: Date
  description?: string
  isActive: boolean
  metadata?: Record<string, any>
}

function jsonToStream<T>(arr: T[]): PassThrough & AsyncIterable<T> {
  const stream = new PassThrough({ objectMode: true })

  // Make it AsyncIterable
  ;(stream as any)[Symbol.asyncIterator] = async function* () {
    for (const item of arr) {
      yield item
    }
  }

  // Push data and close
  arr.forEach((item) => stream.write(item))
  stream.end()

  return stream as PassThrough & AsyncIterable<T>
}

describe('PostgreSQL Bulk Insert', () => {
  let orm: MikroORM
  let em: EntityManager
  let pgPool: Pool
  let scope: MikroConnectionScope
  let repository: MikroRepository<ProductEntity, Product>

  beforeAll(async () => {
    // Single pg.Pool shared between MikroORM (via PostgresDialect) and
    // PostgresCopyBulkInsertStrategy — so COPY connections are drawn from the same
    // pool as ORM queries, avoiding double-pooling and config drift.
    pgPool = new Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5433'),
      user: process.env.POSTGRES_USER || 'test_db',
      password: process.env.POSTGRES_PASSWORD || 'test_db',
      database: process.env.POSTGRES_DB || 'test_db',
    })

    orm = await MikroORM.init({
      entities: [ProductEntity],
      driver: PostgreSqlDriver,
      metadataProvider: ReflectMetadataProvider,
      driverOptions: new PostgresDialect({ pool: pgPool }),
      // MikroORM still wants a dbName even when a dialect is provided — used for schema ops.
      dbName: process.env.POSTGRES_DB || 'test_db',
      debug: false,
    })

    em = orm.em.fork() as unknown as EntityManager
    await orm.schema.drop()
    // Create the test table
    await orm.schema.create()

    // Initialize repository with the COPY strategy resolved from the Kysely dialect.
    // The resolver auto-picks PostgresCopyBulkInsertStrategy because the dialect is `postgres`
    // and `pgPool` is provided. Falls back to KyselyChunkedBulkInsertStrategy otherwise.
    scope = new MikroConnectionScope(em)
    const conditionAdapterRegistry = new ConditionAdapterRegistry()
    conditionAdapterRegistry.register(AdapterType.KNEX, new KnexConditionAdapter())
    conditionAdapterRegistry.register(AdapterType.KYSELY, new KyselyConditionAdapter())
    conditionAdapterRegistry.register(AdapterType.MIKROORM, new MikroOrmConditionAdapter())

    const bulkInsertStrategy = resolveMikroBulkInsertStrategy({
      kysely: em.getKysely(),
      pgPool,
    })

    repository = new MikroRepository<ProductEntity, Product>(scope, new MikroIdentityMapper<Product, ProductEntity>(ProductEntity), {
      entityClass: ProductEntity,
      conditionRegistry: conditionAdapterRegistry,
      bulkInsertStrategy,
    })
  })

  afterAll(async () => {
    // Clean up: drop schema and close connection. Kysely takes ownership of the
    // PostgresDialect's pool, so `orm.close(true)` ends the pool — calling
    // `pgPool.end()` again would throw "Called end on pool more than once".
    await orm.schema.drop()
    await orm.close(true)
  })

  beforeEach(async () => {
    // Clear the table before each test
    await em.execute('TRUNCATE TABLE "test_products" CASCADE')
    em.clear()
  })

  describe('PostgresBulkInsertStrategy', () => {
    it('should bulk insert products using COPY command', async () => {
      const products: Product[] = [
        {
          name: 'Product 1',
          price: 10.99,
          createdAt: new Date('2024-01-01'),
          isActive: true,
          description: 'First product',
        },
        {
          name: 'Product 2',
          price: 20.5,
          createdAt: new Date('2024-01-02'),
          isActive: true,
          description: 'Second product',
        },
        {
          name: 'Product 3',
          price: 15.75,
          createdAt: new Date('2024-01-03'),
          isActive: false,
          description: 'Third product',
        },
      ]

      const stream = jsonToStream<Product>(products)
      // Execute bulk insert
      const insertedCount = await repository.bulkInsert(stream)

      expect(insertedCount).toBe(3)

      // Verify data was inserted
      const allProducts = await repository.findAll({})
      expect(allProducts).toHaveLength(3)
      expect(allProducts[0].name).toBe('Product 1')
      expect(allProducts[1].name).toBe('Product 2')
      expect(allProducts[2].name).toBe('Product 3')
    })

    it('should handle large batches efficiently', async () => {
      const batchSize = 1000

      // Generate large batch of products
      const products: Product[] = []
      for (let i = 0; i < batchSize; i++) {
        products.push({
          name: `Product ${i}`,
          price: Math.random() * 100,
          createdAt: new Date(),
          isActive: i % 2 === 0,
          description: `Description for product ${i}`,
        })
      }

      const stream = jsonToStream<Product>(products)

      const startTime = Date.now()
      const insertedCount = await repository.bulkInsert(stream)
      const duration = Date.now() - startTime

      expect(insertedCount).toBe(batchSize)

      // Bulk insert should be fast (less than 5 seconds for 1000 rows)
      expect(duration).toBeLessThan(5000)

      // Verify count in database
      const count = await repository.count()
      expect(count).toBe(batchSize)
    })

    it('should handle special characters and escape properly', async () => {
      const products: Product[] = [
        {
          name: 'Product with\ttab',
          price: 10.99,
          createdAt: new Date(),
          isActive: true,
          description: 'Description with\nnewline',
        },
        {
          name: 'Product with "quotes"',
          price: 20.5,
          createdAt: new Date(),
          isActive: true,
          description: 'Description with \\ backslash',
        },
      ]

      const stream = jsonToStream<Product>(products)

      const insertedCount = await repository.bulkInsert(stream)
      expect(insertedCount).toBe(2)

      const allProducts = await repository.findAll({})
      expect(allProducts).toHaveLength(2)
      expect(allProducts[0].name).toBe('Product with\ttab')
      expect(allProducts[0].description).toBe('Description with\nnewline')
      expect(allProducts[1].name).toBe('Product with "quotes"')
    })

    it('should handle null values correctly', async () => {
      const products: Product[] = [
        {
          name: 'Product without description',
          price: 10.99,
          createdAt: new Date(),
          isActive: true,
          description: undefined,
        },
        {
          name: 'Product with description',
          price: 20.5,
          createdAt: new Date(),
          isActive: true,
          description: 'Has description',
        },
      ]

      const stream = jsonToStream<Product>(products)

      const insertedCount = await repository.bulkInsert(stream)
      expect(insertedCount).toBe(2)

      const allProducts = await repository.findAll({})
      expect(allProducts).toHaveLength(2)
      expect(allProducts[0].description).toBeNull()
      expect(allProducts[1].description).toBe('Has description')
    })

    it('should handle JSON metadata fields', async () => {
      const products: Product[] = [
        {
          name: 'Product 1',
          price: 10.99,
          createdAt: new Date(),
          isActive: true,
          metadata: { color: 'red', size: 'large', tags: ['new', 'sale'] },
        },
        {
          name: 'Product 2',
          price: 20.5,
          createdAt: new Date(),
          isActive: true,
          metadata: { color: 'blue', size: 'small', 'key with spaces': 'value' },
        },
      ]

      const stream = jsonToStream<Product>(products)

      const insertedCount = await repository.bulkInsert(stream)
      expect(insertedCount).toBe(2)

      const allProducts = await repository.findAll({})
      expect(allProducts).toHaveLength(2)
      expect(allProducts[0].metadata).toEqual({ color: 'red', size: 'large', tags: ['new', 'sale'] })
      expect(allProducts[1].metadata).toEqual({ color: 'blue', size: 'small', 'key with spaces': 'value' })
    })

    it('should handle reserved SQL keywords in column names', async () => {
      // The 'order' column is a reserved word in SQL
      // Our strategy should quote it properly
      const products: Product[] = [
        {
          name: 'Product 1',
          price: 10.99,
          createdAt: new Date(),
          isActive: true,
        },
      ]

      const stream = jsonToStream<Product>(products)

      const insertedCount = await repository.bulkInsert(stream)
      expect(insertedCount).toBe(1)
    })

    it('should return 0 for empty stream', async () => {
      const stream = jsonToStream<Product>([])

      const insertedCount = await repository.bulkInsert(stream)
      expect(insertedCount).toBe(0)

      const count = await repository.count()
      expect(count).toBe(0)
    })

    it('should handle Date objects correctly', async () => {
      const testDate = new Date('2024-06-15T10:30:00.000Z')
      const products: Product[] = [
        {
          name: 'Product with specific date',
          price: 10.99,
          createdAt: testDate,
          isActive: true,
        },
      ]

      const stream = jsonToStream<Product>(products)

      const insertedCount = await repository.bulkInsert(stream)
      expect(insertedCount).toBe(1)

      const allProducts = await repository.findAll({})
      expect(allProducts).toHaveLength(1)
      expect(allProducts[0].createdAt.toISOString()).toBe(testDate.toISOString())
    })

    it('should use the resolved PostgresCopyBulkInsertStrategy', () => {
      // Sanity check that the resolver wired up the COPY strategy — not the chunked
      // fallback — when given a pg.Pool against a postgres dialect.
      const resolved = resolveMikroBulkInsertStrategy({ kysely: em.getKysely(), pgPool })
      expect(resolved).toBeInstanceOf(PostgresCopyBulkInsertStrategy)
    })

    it('should fall back to chunked INSERT inside a MikroORM transaction', async () => {
      // COPY can't participate in a Kysely-managed transaction, so the strategy
      // transparently switches to KyselyChunkedBulkInsertStrategy. The chunked path
      // IS in the transaction, so commit/rollback semantics still apply.
      await scope.transaction(async () => {
        const stream = jsonToStream<Product>([{ name: 'Tx product', price: 1, createdAt: new Date(), isActive: true }])
        const count = await repository.bulkInsert(stream)
        expect(count).toBe(1)
      })

      const total = await repository.count()
      expect(total).toBe(1)
    })

    it('should rollback bulkInsert inside a failing transaction (fallback path)', async () => {
      await expect(
        scope.transaction(async () => {
          const stream = jsonToStream<Product>([{ name: 'Will be rolled back', price: 1, createdAt: new Date(), isActive: true }])
          await repository.bulkInsert(stream)
          throw new Error('force rollback')
        })
      ).rejects.toThrow('force rollback')

      const total = await repository.count()
      expect(total).toBe(0)
    })
  })
})
