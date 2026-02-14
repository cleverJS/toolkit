import { AdapterType, Condition, ConditionAdapterRegistry, ConditionBuilder, KnexConditionAdapter } from '@cleverJS/condition-builder'
import knex, { Knex } from 'knex'
import { PropertySchema } from 'src/utils/types/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { IConnectionScope, IMapper, IRepository, KnexConnectionScope, KnexRepository } from '../../src'

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

interface Order {
  id?: number
  userEmail: string
  productName: string
  quantity: number
  status: string
  createdAt: Date
}

interface Inventory {
  productName: string
  quantity: number
}

// ---------------------------------------------------------------------------
// DB entity types
// ---------------------------------------------------------------------------

interface OrderDBEntity extends Record<string, unknown> {
  id?: number
  user_email: string
  product_name: string
  quantity: number
  status: string
  created_at: Date
}

interface InventoryDBEntity extends Record<string, unknown> {
  product_name: string
  quantity: number
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

class OrderMapper implements IMapper<Order, OrderDBEntity> {
  public toPersistence(domain: Partial<PropertySchema<Order>>): Partial<OrderDBEntity> {
    const entity: Partial<OrderDBEntity> = {}
    if (domain.id !== undefined) entity.id = domain.id
    if (domain.userEmail !== undefined) entity.user_email = domain.userEmail
    if (domain.productName !== undefined) entity.product_name = domain.productName
    if (domain.quantity !== undefined) entity.quantity = domain.quantity
    if (domain.status !== undefined) entity.status = domain.status
    if (domain.createdAt !== undefined) entity.created_at = domain.createdAt
    return entity
  }

  public toDomain(entity: OrderDBEntity): Order {
    return {
      id: entity.id,
      userEmail: entity.user_email,
      productName: entity.product_name,
      quantity: entity.quantity,
      status: entity.status,
      createdAt: entity.created_at,
    }
  }

  public toEntity(domain: Partial<Order>): OrderDBEntity {
    const entity: OrderDBEntity = {
      user_email: domain.userEmail || '',
      product_name: domain.productName || '',
      quantity: domain.quantity || 0,
      status: domain.status || 'pending',
      created_at: domain.createdAt || new Date(),
    }
    if (domain.id !== undefined) entity.id = domain.id
    return entity
  }
}

class InventoryMapper implements IMapper<Inventory, InventoryDBEntity> {
  public toPersistence(domain: Partial<PropertySchema<Inventory>>): Partial<InventoryDBEntity> {
    const entity: Partial<InventoryDBEntity> = {}
    if (domain.productName !== undefined) entity.product_name = domain.productName
    if (domain.quantity !== undefined) entity.quantity = domain.quantity
    return entity
  }

  public toDomain(entity: InventoryDBEntity): Inventory {
    return {
      productName: entity.product_name,
      quantity: entity.quantity,
    }
  }

  public toEntity(domain: Partial<Inventory>): InventoryDBEntity {
    return {
      product_name: domain.productName || '',
      quantity: domain.quantity || 0,
    }
  }
}

// ---------------------------------------------------------------------------
// Services — zero transaction awareness, pure business logic
// ---------------------------------------------------------------------------

class OrderService {
  public constructor(private readonly orderRepo: IRepository<Order, 'id'>) {}

  public async create(userEmail: string, productName: string, quantity: number): Promise<Order> {
    return this.orderRepo.insert({
      userEmail,
      productName,
      quantity,
      status: 'confirmed',
      createdAt: new Date(),
    })
  }
}

class InventoryService {
  public constructor(private readonly inventoryRepo: IRepository<Inventory>) {}

  public async reserve(productName: string, quantity: number): Promise<void> {
    const condition: Condition = ConditionBuilder.create({ product_name: productName }).build()
    const item = await this.inventoryRepo.findOne(condition)

    if (!item) {
      throw new Error(`Product not found: ${productName}`)
    }

    if (item.quantity < quantity) {
      throw new Error(`Insufficient stock for ${productName}: have ${item.quantity}, need ${quantity}`)
    }

    await this.inventoryRepo.update(condition, { quantity: item.quantity - quantity })
  }
}

// ---------------------------------------------------------------------------
// Orchestrator — the only place that knows about transactions
// ---------------------------------------------------------------------------

class PlaceOrderUseCase {
  public constructor(
    private readonly orderService: OrderService,
    private readonly inventoryService: InventoryService,
    private readonly scope: IConnectionScope
  ) {}

  public async execute(userEmail: string, productName: string, quantity: number): Promise<Order> {
    return this.scope.transaction(async () => {
      await this.inventoryService.reserve(productName, quantity)
      return this.orderService.create(userEmail, productName, quantity)
    })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Transaction through business layer', () => {
  let db: Knex
  let scope: KnexConnectionScope
  let orderRepo: KnexRepository<OrderDBEntity, Order, 'id'>
  let inventoryRepo: KnexRepository<InventoryDBEntity, Inventory>
  let orderService: OrderService
  let inventoryService: InventoryService
  let placeOrder: PlaceOrderUseCase

  beforeAll(async () => {
    ConditionAdapterRegistry.getInstance().register(AdapterType.KNEX, new KnexConditionAdapter())

    db = knex({
      client: 'pg',
      connection: {
        host: process.env.POSTGRES_HOST || '127.0.0.1',
        port: parseInt(process.env.POSTGRES_PORT || '5433'),
        user: process.env.POSTGRES_USER || 'test_db',
        password: process.env.POSTGRES_PASSWORD || 'test_db',
        database: process.env.POSTGRES_DB || 'test_db',
      },
    })

    await db.schema.dropTableIfExists('test_orders')
    await db.schema.dropTableIfExists('test_inventory')

    await db.schema.createTable('test_orders', (table) => {
      table.increments('id').primary()
      table.string('user_email').notNullable()
      table.string('product_name').notNullable()
      table.integer('quantity').notNullable()
      table.string('status').notNullable()
      table.timestamp('created_at', { useTz: false }).notNullable()
    })

    await db.schema.createTable('test_inventory', (table) => {
      table.string('product_name').primary()
      table.integer('quantity').notNullable()
    })

    scope = new KnexConnectionScope(db)

    orderRepo = new KnexRepository<OrderDBEntity, Order, 'id'>(scope, new OrderMapper(), {
      table: 'test_orders',
      primary: ['id'],
    })

    inventoryRepo = new KnexRepository<InventoryDBEntity, Inventory>(scope, new InventoryMapper(), {
      table: 'test_inventory',
      primary: ['product_name'],
    })

    orderService = new OrderService(orderRepo)
    inventoryService = new InventoryService(inventoryRepo)
    placeOrder = new PlaceOrderUseCase(orderService, inventoryService, scope)
  })

  afterAll(async () => {
    await db.schema.dropTableIfExists('test_orders')
    await db.schema.dropTableIfExists('test_inventory')
    await db.destroy()
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE TABLE ?? CASCADE', ['test_orders'])
    await db.raw('TRUNCATE TABLE ?? CASCADE', ['test_inventory'])

    // Seed inventory
    await inventoryRepo.insert({ productName: 'Widget', quantity: 10 })
    await inventoryRepo.insert({ productName: 'Gadget', quantity: 5 })
  })

  it('should commit order and decrement inventory on success', async () => {
    const order = await placeOrder.execute('alice@example.com', 'Widget', 3)

    expect(order.status).toBe('confirmed')
    expect(order.quantity).toBe(3)

    const orderCount = await orderRepo.count()
    expect(orderCount).toBe(1)

    const condition = ConditionBuilder.create({ product_name: 'Widget' }).build()
    const widget = await inventoryRepo.findOne(condition)
    expect(widget?.quantity).toBe(7)
  })

  it('should rollback both order and inventory on insufficient stock', async () => {
    await expect(placeOrder.execute('bob@example.com', 'Gadget', 100)).rejects.toThrow('Insufficient stock')

    // No order created
    const orderCount = await orderRepo.count()
    expect(orderCount).toBe(0)

    // Inventory unchanged
    const condition = ConditionBuilder.create({ product_name: 'Gadget' }).build()
    const gadget = await inventoryRepo.findOne(condition)
    expect(gadget?.quantity).toBe(5)
  })

  it('should rollback both order and inventory on product not found', async () => {
    await expect(placeOrder.execute('bob@example.com', 'NonExistent', 1)).rejects.toThrow('Product not found')

    const orderCount = await orderRepo.count()
    expect(orderCount).toBe(0)
  })

  it('should handle multiple sequential orders correctly', async () => {
    await placeOrder.execute('alice@example.com', 'Widget', 3)
    await placeOrder.execute('bob@example.com', 'Widget', 4)

    const orderCount = await orderRepo.count()
    expect(orderCount).toBe(2)

    const condition = ConditionBuilder.create({ product_name: 'Widget' }).build()
    const widget = await inventoryRepo.findOne(condition)
    expect(widget?.quantity).toBe(3)
  })

  it('should rollback failed order without affecting earlier committed order', async () => {
    // First order succeeds
    await placeOrder.execute('alice@example.com', 'Widget', 8)

    // Second order fails — not enough stock left
    await expect(placeOrder.execute('bob@example.com', 'Widget', 5)).rejects.toThrow('Insufficient stock')

    // Only the first order exists
    const orderCount = await orderRepo.count()
    expect(orderCount).toBe(1)

    // Inventory reflects only the first order
    const condition = ConditionBuilder.create({ product_name: 'Widget' }).build()
    const widget = await inventoryRepo.findOne(condition)
    expect(widget?.quantity).toBe(2)
  })

  it('services work without transaction when called directly', async () => {
    // Services function normally outside of any transaction
    const order = await orderService.create('direct@example.com', 'Widget', 1)
    expect(order.status).toBe('confirmed')

    await inventoryService.reserve('Widget', 1)
    const condition = ConditionBuilder.create({ product_name: 'Widget' }).build()
    const widget = await inventoryRepo.findOne(condition)
    expect(widget?.quantity).toBe(9)
  })
})
