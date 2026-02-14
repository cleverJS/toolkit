import { BaseEntity, Entity, EntityManager, MikroORM, PrimaryKey, Property } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { BulkInsertStrategyRegistry, FallbackBulkInsertStrategy, IBulkInsertStrategy, PostgresBulkInsertStrategy } from '../../../src'

@Entity({ tableName: 'registry_dummy' })
class DummyEntity extends BaseEntity {
  @PrimaryKey({ autoincrement: true })
  public id?: number

  @Property()
  public name: string = ''
}

describe('BulkInsertStrategyRegistry', () => {
  let orm: MikroORM
  let em: EntityManager

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [DummyEntity],
      driver: PostgreSqlDriver,
      dbName: process.env.POSTGRES_DB || 'test_db',
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5433'),
      user: process.env.POSTGRES_USER || 'test_db',
      password: process.env.POSTGRES_PASSWORD || 'test_db',
      debug: false,
    })
    em = orm.em.fork()
  })

  afterAll(async () => {
    await orm.close()
  })

  beforeEach(() => {
    BulkInsertStrategyRegistry.getInstance().reset()
  })

  it('should be a singleton', () => {
    const a = BulkInsertStrategyRegistry.getInstance()
    const b = BulkInsertStrategyRegistry.getInstance()
    expect(a).toBe(b)
  })

  it('should return PostgresBulkInsertStrategy for PostgreSQL EntityManager', () => {
    const registry = BulkInsertStrategyRegistry.getInstance()
    const strategy = registry.getStrategy(em)
    expect(strategy).toBeInstanceOf(PostgresBulkInsertStrategy)
  })

  it('should return fallback when no strategy matches', () => {
    const registry = BulkInsertStrategyRegistry.getInstance()
    const fakeEm = { getDriver: () => ({ getPlatform: () => ({ constructor: { name: 'FakePlatform' } }) }) } as any
    const strategy = registry.getStrategy(fakeEm)
    expect(strategy).toBeInstanceOf(FallbackBulkInsertStrategy)
  })

  it('should allow registering custom strategies', () => {
    const registry = BulkInsertStrategyRegistry.getInstance()

    const custom: IBulkInsertStrategy = {
      isSupported: () => true,
      execute: async () => 42,
    }

    registry.registerStrategy(custom)
    // Custom is checked after built-in PostgresBulkInsertStrategy.
    // For a non-Postgres EM, our custom (always supported) matches before fallback.
    const fakeEm = { getDriver: () => ({ getPlatform: () => ({ constructor: { name: 'FakePlatform' } }) }) } as any
    const strategy = registry.getStrategy(fakeEm)
    expect(strategy).toBe(custom)
  })

  it('should re-register PostgresBulkInsertStrategy after reset', () => {
    const registry = BulkInsertStrategyRegistry.getInstance()
    registry.reset()
    const strategy = registry.getStrategy(em)
    expect(strategy).toBeInstanceOf(PostgresBulkInsertStrategy)
  })
})
