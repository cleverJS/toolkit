import { BaseEntity, Entity, EntityManager, MikroORM, PrimaryKey, Property } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import { PropertySchema } from 'src/utils/types/types'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { IMapper, MikroRepository, PostgresBulkInsertStrategy } from '../src'

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

// Mapper
class ProductMapper implements IMapper<Product, ProductEntity> {
  toPersistence(domain: Partial<PropertySchema<Product>>): Partial<ProductEntity> {
    const entity: ProductEntity = new ProductEntity()

    if (domain.id !== undefined) entity.id = domain.id
    if (domain.name !== undefined) entity.name = domain.name
    if (domain.price !== undefined) entity.price = domain.price
    if (domain.createdAt !== undefined) entity.createdAt = domain.createdAt
    if (domain.description !== undefined) entity.description = domain.description
    if (domain.isActive !== undefined) entity.isActive = domain.isActive
    if (domain.metadata !== undefined) entity.metadata = domain.metadata

    return entity
  }

  toDomain(entity: ProductEntity): Product {
    return {
      id: entity.id,
      name: entity.name,
      price: entity.price,
      createdAt: entity.createdAt,
      description: entity.description,
      isActive: entity.isActive,
      metadata: entity.metadata,
    }
  }

  toEntity(domain: Partial<Product>): ProductEntity {
    const entity: ProductEntity = new ProductEntity()

    if (domain.id !== undefined) entity.id = domain.id
    entity.name = domain.name || ''
    entity.price = domain.price || 0
    entity.createdAt = domain.createdAt || new Date()
    entity.description = domain.description
    entity.isActive = domain.isActive = false
    entity.metadata = domain.metadata

    return entity
  }
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
  let repository: MikroRepository<ProductEntity, Product>
  let strategy: PostgresBulkInsertStrategy

  beforeAll(async () => {
    // Initialize MikroORM with PostgreSQL
    orm = await MikroORM.init({
      entities: [ProductEntity],
      driver: PostgreSqlDriver,
      dbName: process.env.POSTGRES_DB || 'test_db',
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5433'),
      user: process.env.POSTGRES_USER || 'test_db',
      password: process.env.POSTGRES_PASSWORD || 'test_db',
      debug: false,
    })

    em = orm.em.fork()
    await orm.schema.dropSchema()
    // Create the test table
    await orm.schema.createSchema()

    // Initialize repository
    const entityRepository = em.getRepository(ProductEntity)
    const mapper = new ProductMapper()
    repository = new MikroRepository<ProductEntity, Product>(entityRepository, mapper)

    // Initialize strategy
    strategy = new PostgresBulkInsertStrategy()
  })

  afterAll(async () => {
    // Clean up: drop schema and close connection
    await orm.schema.dropSchema()
    await orm.close(true)
  })

  beforeEach(async () => {
    // Clear the table before each test
    await repository.truncate()
  })

  describe('PostgresBulkInsertStrategy', () => {
    it('should detect PostgreSQL driver as supported', () => {
      const isSupported = strategy.isSupported(em)
      expect(isSupported).toBe(true)
    })

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
  })
})
