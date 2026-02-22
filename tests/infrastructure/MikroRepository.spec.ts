import {
  AdapterType,
  Condition,
  ConditionAdapterRegistry,
  ConditionBuilder,
  KnexConditionAdapter,
  MikroOrmConditionAdapter,
} from '@cleverJS/condition-builder'
import { BaseEntity, Entity, MikroORM, PrimaryKey, Property } from '@mikro-orm/core'
import { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { IRepositoryHooks, MikroConnectionScope, MikroIdentityMapper, MikroRepository, Paginator } from '../../src'

describe('MikroRepository', () => {
  let orm: MikroORM
  let em: EntityManager
  let scope: MikroConnectionScope
  let repository: MikroRepository<UserEntity, User>
  let repositoryJob: MikroRepository<JobEntity, Job, 'id'>
  let conditionAdapterRegistry: ConditionAdapterRegistry

  beforeAll(async () => {
    conditionAdapterRegistry = new ConditionAdapterRegistry()
    conditionAdapterRegistry.register(AdapterType.KNEX, new KnexConditionAdapter())
    conditionAdapterRegistry.register(AdapterType.MIKROORM, new MikroOrmConditionAdapter())

    // Initialize MikroORM with PostgreSQL
    orm = await MikroORM.init({
      entities: [UserEntity, JobEntity],
      driver: PostgreSqlDriver,
      dbName: process.env.POSTGRES_DB || 'test_db',
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5433'),
      user: process.env.POSTGRES_USER || 'test_db',
      password: process.env.POSTGRES_PASSWORD || 'test_db',
      debug: false,
    })

    em = orm.em.fork() as unknown as EntityManager

    // Create the test table
    await orm.schema.dropSchema()
    await orm.schema.createSchema()

    // Initialize scope and repositories
    scope = new MikroConnectionScope(em)
    repository = new MikroRepository<UserEntity, User>(scope, new MikroIdentityMapper<User, UserEntity>(UserEntity), {
      entityClass: UserEntity,
      conditionRegistry: conditionAdapterRegistry,
    })
    repositoryJob = new MikroRepository<JobEntity, Job, 'id'>(scope, new MikroIdentityMapper<Job, JobEntity>(JobEntity), {
      entityClass: JobEntity,
      conditionRegistry: conditionAdapterRegistry,
    })
  })

  afterAll(async () => {
    // Clean up: drop schema and close connection
    await orm.schema.dropSchema()
    await orm.close(true)
  })

  beforeEach(async () => {
    // Clear all tables before each test
    await em.execute('TRUNCATE TABLE "test_users" CASCADE')
    await em.execute('TRUNCATE TABLE "test_jobs" CASCADE')
    em.clear()
  })

  describe('insert', () => {
    it('should insert a single user', async () => {
      const userData: Omit<User, 'id'> = {
        email: 'john@example.com',
        name: 'John Doe',
        age: 30,
        isActive: true,
        createdAt: new Date('2024-01-01'),
      }

      const user = await repository.insert(userData)

      expect(user.email).toBe('john@example.com')
      expect(user.name).toBe('John Doe')
      expect(user.age).toBe(30)
      expect(user.isActive).toBe(true)
    })

    it('should insert user with optional fields', async () => {
      const userData: Omit<User, 'id'> = {
        email: 'jane@example.com',
        name: 'Jane Smith',
        age: 25,
        isActive: false,
        createdAt: new Date(),
        bio: 'Software developer',
      }

      const user = await repository.insert(userData)

      expect(user.bio).toBe('Software developer')
    })
  })

  describe('insertMany', () => {
    it('should insert multiple users and return primary keys', async () => {
      const users: Omit<User, 'id'>[] = [
        {
          email: 'user1@example.com',
          name: 'User 1',
          age: 20,
          isActive: true,
          createdAt: new Date(),
        },
        {
          email: 'user2@example.com',
          name: 'User 2',
          age: 30,
          isActive: true,
          createdAt: new Date(),
        },
        {
          email: 'user3@example.com',
          name: 'User 3',
          age: 40,
          isActive: false,
          createdAt: new Date(),
        },
      ]

      const ids = await repository.insertMany<string[]>(users)

      expect(ids).toHaveLength(3)
      expect(ids.every((id) => typeof id === 'string')).toBe(true)
    })

    it('should return empty array for empty input', async () => {
      const ids = await repository.insertMany<number[]>([])
      expect(ids).toEqual([])
    })
  })

  describe('findOne', () => {
    it('should find user by email condition', async () => {
      // Insert test data
      await repository.insert({
        email: 'find@example.com',
        name: 'Find Me',
        age: 35,
        isActive: true,
        createdAt: new Date(),
      })

      const condition: Condition = ConditionBuilder.create({ email: 'find@example.com' }).build()
      const user = await repository.findOne(condition)

      expect(user).toBeDefined()
      expect(user?.email).toBe('find@example.com')
      expect(user?.name).toBe('Find Me')
    })

    it('should return null when user not found', async () => {
      const condition: Condition = ConditionBuilder.create({ email: 'notfound@example.com' }).build()
      const user = await repository.findOne(condition)

      expect(user).toBeNull()
    })

    it('should find user by complex condition', async () => {
      await repository.insert({
        email: 'young@example.com',
        name: 'Young User',
        age: 18,
        isActive: true,
        createdAt: new Date(),
      })

      const condition: Condition = ConditionBuilder.create({ age: { $lt: 20 }, isActive: true }).build()

      const user = await repository.findOne(condition)

      expect(user).toBeDefined()
      expect(user?.age).toBe(18)
    })
  })

  describe('findAll', () => {
    beforeEach(async () => {
      // Insert test data
      const users: User[] = [
        { email: 'alice@example.com', name: 'Alice', age: 25, isActive: true, createdAt: new Date('2024-01-01') },
        { email: 'bob@example.com', name: 'Bob', age: 30, isActive: true, createdAt: new Date('2024-01-02') },
        { email: 'charlie@example.com', name: 'Charlie', age: 35, isActive: false, createdAt: new Date('2024-01-03') },
        { email: 'david@example.com', name: 'David', age: 40, isActive: true, createdAt: new Date('2024-01-04') },
        { email: 'eve@example.com', name: 'Eve', age: 45, isActive: false, createdAt: new Date('2024-01-05') },
      ]

      await repository.insertMany(users)
    })

    it('should find all users without conditions', async () => {
      const users = await repository.findAll()

      expect(users).toHaveLength(5)
    })

    it('should find users with condition', async () => {
      const condition: Condition = ConditionBuilder.create({ isActive: true }).build()
      const users = await repository.findAll({ condition })

      expect(users).toHaveLength(3)
      expect(users.every((u) => u.isActive)).toBe(true)
    })

    it('should find users with sorting', async () => {
      const users = await repository.findAll({
        sort: { age: 'asc' },
      })

      expect(users[0].age).toBe(25)
      expect(users[4].age).toBe(45)
    })

    it('should find users with sorting descending', async () => {
      const users = await repository.findAll({
        sort: { age: 'desc' },
      })

      expect(users[0].age).toBe(45)
      expect(users[4].age).toBe(25)
    })

    it('should find users with pagination', async () => {
      const paginator = new Paginator({ page: 1, perPage: 2 })

      const users = await repository.findAll({
        paginator,
        sort: { age: 'asc' },
      })

      expect(users).toHaveLength(2)
      expect(users[0].age).toBe(25)
      expect(users[1].age).toBe(30)
    })

    it('should find users with pagination on second page', async () => {
      const paginator = new Paginator({ page: 2, perPage: 2 })

      const users = await repository.findAll({
        paginator,
        sort: { age: 'asc' },
      })

      expect(users).toHaveLength(2)
      expect(users[0].age).toBe(35)
      expect(users[1].age).toBe(40)
    })

    it('should throw error when using paginator without sort', async () => {
      const paginator = new Paginator({ page: 1, perPage: 2 })

      await expect(repository.findAll({ paginator })).rejects.toThrow('Sort is required when paginator is used')
    })

    it('should find users with field selection', async () => {
      const users = await repository.findPartial({
        select: ['email', 'name'],
      })

      expect(users).toHaveLength(5)
      expect(users[0].email).toBeDefined()
      expect(users[0].name).toBeDefined()
    })

    it('should combine condition, sort, and pagination', async () => {
      const condition: Condition = ConditionBuilder.create({ age: { $gte: 30 } }).build()

      const paginator = new Paginator({ page: 1, perPage: 2 })

      const users = await repository.findAll({
        condition,
        paginator,
        sort: { age: 'asc' },
      })

      expect(users).toHaveLength(2)
      expect(users[0].age).toBe(30)
      expect(users[1].age).toBe(35)
    })
  })

  describe('count', () => {
    beforeEach(async () => {
      const users: Omit<User, 'id'>[] = [
        { email: 'user1@example.com', name: 'User 1', age: 20, isActive: true, createdAt: new Date() },
        { email: 'user2@example.com', name: 'User 2', age: 30, isActive: true, createdAt: new Date() },
        { email: 'user3@example.com', name: 'User 3', age: 40, isActive: false, createdAt: new Date() },
      ]

      await repository.insertMany(users)
    })

    it('should count all users without condition', async () => {
      const count = await repository.count()

      expect(count).toBe(3)
    })

    it('should count users with condition', async () => {
      const condition: Condition = ConditionBuilder.create({ isActive: true }).build()
      const count = await repository.count(condition)

      expect(count).toBe(2)
    })

    it('should return 0 for empty table', async () => {
      await em.execute('TRUNCATE TABLE "test_users" CASCADE')
      em.clear()
      const count = await repository.count()

      expect(count).toBe(0)
    })

    it('should count with complex condition', async () => {
      const condition: Condition = ConditionBuilder.create({ age: { $gte: 25 }, isActive: true }).build()

      const count = await repository.count(condition)

      expect(count).toBe(1) // Only user2 matches
    })
  })

  describe('updateOne', () => {
    it('should update a single user', async () => {
      const user = await repository.insert({
        email: 'update@example.com',
        name: 'Update Me',
        age: 25,
        isActive: true,
        createdAt: new Date(),
      })

      const condition: Condition = ConditionBuilder.create({ email: user.email }).build()

      const updatedUser = await repository.updateOne(condition, { name: 'Updated Name' })

      expect(updatedUser.name).toBe('Updated Name')
      expect(updatedUser.age).toBe(25)
      expect(updatedUser.email).toBe('update@example.com') // unchanged
    })

    it('should throw error when entity not found', async () => {
      const condition: Condition = ConditionBuilder.create({ email: 'qwe@no.tld' }).build()

      await expect(repository.updateOne(condition, { name: 'Updated' })).rejects.toThrow('Entity to update not found')
    })

    it('should throw error when multiple entities match', async () => {
      await repository.insertMany([
        { email: 'user1@example.com', name: 'User 1', age: 25, isActive: true, createdAt: new Date() },
        { email: 'user2@example.com', name: 'User 2', age: 25, isActive: true, createdAt: new Date() },
      ])

      const condition: Condition = ConditionBuilder.create({ age: 25 }).build()

      await expect(repository.updateOne(condition, { name: 'Updated' })).rejects.toThrow('Multiple entities found for update')
    })

    it('should update optional fields', async () => {
      const user = await repository.insert({
        email: 'bio@example.com',
        name: 'Bio User',
        age: 30,
        isActive: true,
        createdAt: new Date(),
      })

      const condition: Condition = ConditionBuilder.create({ email: user.email }).build()

      const updatedUser = await repository.updateOne(condition, { bio: 'New bio' })

      expect(updatedUser.bio).toBe('New bio')
    })

    it('should update boolean fields', async () => {
      const user = await repository.insert({
        email: 'active@example.com',
        name: 'Active User',
        age: 30,
        isActive: true,
        createdAt: new Date(),
      })

      const condition: Condition = ConditionBuilder.create({ email: user.email }).build()
      const updatedUser = await repository.updateOne(condition, { isActive: false })

      expect(updatedUser.isActive).toBe(false)
    })
  })

  describe('delete', () => {
    it('should delete users by condition', async () => {
      await repository.insertMany([
        { email: 'delete1@example.com', name: 'Delete 1', age: 25, isActive: true, createdAt: new Date() },
        { email: 'delete2@example.com', name: 'Delete 2', age: 30, isActive: true, createdAt: new Date() },
        { email: 'keep@example.com', name: 'Keep', age: 35, isActive: false, createdAt: new Date() },
      ])

      const condition: Condition = ConditionBuilder.create({ isActive: true }).build()
      const deletedCount = await repository.delete(condition)

      expect(deletedCount).toBe(2)

      const remainingUsers = await repository.findAll()
      expect(remainingUsers).toHaveLength(1)
      expect(remainingUsers[0].email).toBe('keep@example.com')
    })

    it('should delete single user', async () => {
      const user = await repository.insert({
        email: 'single@example.com',
        name: 'Single',
        age: 25,
        isActive: true,
        createdAt: new Date(),
      })

      const condition: Condition = ConditionBuilder.create({ email: user.email }).build()
      const deletedCount = await repository.delete(condition)

      expect(deletedCount).toBe(1)

      const count = await repository.count()
      expect(count).toBe(0)
    })

    it('should return 0 when no users match condition', async () => {
      await repository.insert({
        email: 'test@example.com',
        name: 'Test',
        age: 25,
        isActive: true,
        createdAt: new Date(),
      })

      const condition: Condition = ConditionBuilder.create({ email: 'notfound@example.com' }).build()

      const deletedCount = await repository.delete(condition)

      expect(deletedCount).toBe(0)
    })
  })

  describe('stream', () => {
    beforeEach(async () => {
      const users: Omit<User, 'id'>[] = [
        { email: 'stream1@example.com', name: 'Stream 1', age: 20, isActive: true, createdAt: new Date('2024-01-01') },
        { email: 'stream2@example.com', name: 'Stream 2', age: 30, isActive: true, createdAt: new Date('2024-01-02') },
        { email: 'stream3@example.com', name: 'Stream 3', age: 40, isActive: false, createdAt: new Date('2024-01-03') },
      ]

      await repository.insertMany(users)
    })

    it('should stream all users', async () => {
      const stream = repository.stream<User>({ sort: { age: 'asc' } })
      const users: User[] = []

      for await (const user of stream) {
        users.push(user)
      }

      expect(users).toHaveLength(3)
      expect(users[0].age).toBe(20)
      expect(users[2].age).toBe(40)
    })

    it('should stream with condition', async () => {
      const condition: Condition = ConditionBuilder.create({ is_active: true }).build()
      const stream = repository.stream<User>({ condition, sort: { age: 'asc' } })
      const users: User[] = []

      for await (const user of stream) {
        users.push(user)
      }

      expect(users).toHaveLength(2)
      expect(users.every((u) => u.isActive)).toBe(true)
    })

    it('should stream with pagination', async () => {
      const paginator = new Paginator({ page: 1, perPage: 2 })

      const stream = repository.stream<User>({
        paginator,
        sort: { age: 'asc' },
      })
      const users: User[] = []

      for await (const user of stream) {
        users.push(user)
      }

      expect(users).toHaveLength(2)
      expect(users[0].age).toBe(20)
      expect(users[1].age).toBe(30)
    })

    it('should throw error when streaming with paginator without sort', () => {
      const paginator = new Paginator({ page: 1, perPage: 2 })

      expect(() => repository.stream({ paginator })).toThrow('Sort is required when paginator is used')
    })
  })

  describe('bulkInsert', () => {
    it('should bulk insert users from stream', async () => {
      const users: Omit<User, 'id'>[] = [
        { email: 'bulk1@example.com', name: 'Bulk 1', age: 25, isActive: true, createdAt: new Date() },
        { email: 'bulk2@example.com', name: 'Bulk 2', age: 30, isActive: true, createdAt: new Date() },
        { email: 'bulk3@example.com', name: 'Bulk 3', age: 35, isActive: false, createdAt: new Date() },
      ]

      const stream = jsonToStream(users)
      const insertedCount = await repository.bulkInsert(stream)

      expect(insertedCount).toBe(3)

      const allUsers = await repository.findAll()
      expect(allUsers).toHaveLength(3)
    })

    it('should return 0 for empty stream', async () => {
      const stream = jsonToStream<Omit<User, 'id'>>([])
      const insertedCount = await repository.bulkInsert(stream)

      expect(insertedCount).toBe(0)
    })
  })

  describe('primary key', () => {
    it('should expose primary key information', () => {
      expect(repository.primary).toBeDefined()
      expect(repositoryJob.primary).toEqual(['id'])
    })
  })

  describe('transaction', () => {
    it('should commit on success', async () => {
      await scope.transaction(async () => {
        await repository.insert({
          email: 'tx@example.com',
          name: 'TX User',
          age: 30,
          isActive: true,
          createdAt: new Date(),
        })
      })

      const count = await repository.count()
      expect(count).toBe(1)
    })

    it('should rollback on error', async () => {
      await expect(
        scope.transaction(async () => {
          await repository.insert({
            email: 'rollback@example.com',
            name: 'Rollback User',
            age: 25,
            isActive: true,
            createdAt: new Date(),
          })
          throw new Error('force rollback')
        })
      ).rejects.toThrow('force rollback')

      const count = await repository.count()
      expect(count).toBe(0)
    })

    it('should commit multi-repo transaction on success', async () => {
      await scope.transaction(async () => {
        await repository.insert({
          email: 'multi@example.com',
          name: 'Multi User',
          age: 30,
          isActive: true,
          createdAt: new Date(),
        })
        await repositoryJob.insert({
          name: 'Multi Job',
          createdAt: new Date(),
        })
      })

      const userCount = await repository.count()
      const jobCount = await repositoryJob.count()
      expect(userCount).toBe(1)
      expect(jobCount).toBe(1)
    })

    it('should rollback multi-repo transaction on error', async () => {
      await expect(
        scope.transaction(async () => {
          await repository.insert({
            email: 'multi-fail@example.com',
            name: 'Multi Fail',
            age: 30,
            isActive: true,
            createdAt: new Date(),
          })
          await repositoryJob.insert({
            name: 'Multi Fail Job',
            createdAt: new Date(),
          })
          throw new Error('multi rollback')
        })
      ).rejects.toThrow('multi rollback')

      const userCount = await repository.count()
      const jobCount = await repositoryJob.count()
      expect(userCount).toBe(0)
      expect(jobCount).toBe(0)
    })

    it('should support nested transactions (savepoints) — inner rollback does not affect outer', async () => {
      await scope.transaction(async () => {
        await repository.insert({
          email: 'outer@example.com',
          name: 'Outer',
          age: 30,
          isActive: true,
          createdAt: new Date(),
        })

        // Inner transaction fails — should not roll back outer
        await scope
          .transaction(async () => {
            await repository.insert({
              email: 'inner@example.com',
              name: 'Inner',
              age: 25,
              isActive: true,
              createdAt: new Date(),
            })
            throw new Error('inner rollback')
          })
          .catch(() => {
            // swallow inner error
          })
      })

      const count = await repository.count()
      expect(count).toBe(1)

      const condition = ConditionBuilder.create({ email: 'outer@example.com' }).build()
      const user = await repository.findOne(condition)
      expect(user).toBeDefined()
      expect(user?.name).toBe('Outer')
    })

    it('should bulkInsert inside a transaction', async () => {
      await scope.transaction(async () => {
        const stream = jsonToStream<Omit<User, 'id'>>([
          { email: 'bulk-tx1@example.com', name: 'Bulk TX 1', age: 30, isActive: true, createdAt: new Date() },
          { email: 'bulk-tx2@example.com', name: 'Bulk TX 2', age: 25, isActive: true, createdAt: new Date() },
        ])
        const count = await repository.bulkInsert(stream)
        expect(count).toBe(2)
      })

      const total = await repository.count()
      expect(total).toBe(2)
    })

    it('should rollback bulkInsert when transaction fails', async () => {
      await expect(
        scope.transaction(async () => {
          const stream = jsonToStream<Omit<User, 'id'>>([
            { email: 'bulk-rb1@example.com', name: 'Bulk RB 1', age: 30, isActive: true, createdAt: new Date() },
            { email: 'bulk-rb2@example.com', name: 'Bulk RB 2', age: 25, isActive: true, createdAt: new Date() },
          ])
          await repository.bulkInsert(stream)
          throw new Error('force rollback')
        })
      ).rejects.toThrow('force rollback')

      const total = await repository.count()
      expect(total).toBe(0)
    })

    it('should report isInTransaction correctly', async () => {
      expect(scope.isInTransaction()).toBe(false)

      await scope.transaction(async () => {
        expect(scope.isInTransaction()).toBe(true)
      })

      expect(scope.isInTransaction()).toBe(false)
    })

    it('should support explicit isolation level', async () => {
      await scope.transaction(
        async () => {
          await repository.insert({
            email: 'iso@example.com',
            name: 'Isolation User',
            age: 30,
            isActive: true,
            createdAt: new Date(),
          })
        },
        { isolationLevel: 'serializable' }
      )

      const count = await repository.count()
      expect(count).toBe(1)
    })

    it('should insert inside transaction using the forked EM', async () => {
      await scope.transaction(async () => {
        const user = await repository.insert({
          email: 'forked@example.com',
          name: 'Forked EM',
          age: 28,
          isActive: true,
          createdAt: new Date(),
        })
        expect(user.email).toBe('forked@example.com')
      })

      const condition = ConditionBuilder.create({ email: 'forked@example.com' }).build()
      const found = await repository.findOne(condition)
      expect(found).toBeDefined()
      expect(found?.name).toBe('Forked EM')
    })

    it('should updateOne with assign + flush correctly on forked EM', async () => {
      const user = await repository.insert({
        email: 'update-tx@example.com',
        name: 'Update TX',
        age: 30,
        isActive: true,
        createdAt: new Date(),
      })

      await scope.transaction(async () => {
        const condition = ConditionBuilder.create({ email: user.email }).build()
        const updated = await repository.updateOne(condition, { name: 'Updated in TX' })
        expect(updated.name).toBe('Updated in TX')
      })

      const condition = ConditionBuilder.create({ email: user.email }).build()
      const found = await repository.findOne(condition)
      expect(found?.name).toBe('Updated in TX')
    })

    it('should not pollute parent EM identity map on rollback', async () => {
      await repository.insert({
        email: 'original@example.com',
        name: 'Original',
        age: 30,
        isActive: true,
        createdAt: new Date(),
      })

      await expect(
        scope.transaction(async () => {
          const condition = ConditionBuilder.create({ email: 'original@example.com' }).build()
          await repository.updateOne(condition, { name: 'Modified in TX' })
          throw new Error('rollback')
        })
      ).rejects.toThrow('rollback')

      // Parent EM should still see the original value
      const condition = ConditionBuilder.create({ email: 'original@example.com' }).build()
      const found = await repository.findOne(condition)
      expect(found?.name).toBe('Original')
    })
  })

  describe('hooks', () => {
    const auditDate = new Date('2025-06-01T00:00:00Z')

    let hookedRepository: MikroRepository<JobEntity, Job, 'id'>

    beforeAll(() => {
      const hooks: IRepositoryHooks<Job> = {
        beforeInsert(data) {
          return {
            ...data,
            createdAt: auditDate,
          }
        },
        beforeUpdate(data) {
          return { ...data, name: `modified:${data.name ?? ''}` }
        },
      }

      hookedRepository = new MikroRepository<JobEntity, Job, 'id'>(scope, new MikroIdentityMapper<Job, JobEntity>(JobEntity), {
        entityClass: JobEntity,
        conditionRegistry: conditionAdapterRegistry,
        hooks,
      })
    })

    beforeEach(async () => {
      await em.execute('TRUNCATE TABLE "test_jobs" CASCADE')
      em.clear()
    })

    it('should set createdAt via beforeInsert on insert', async () => {
      const job = await hookedRepository.insert({ name: 'Hook Job' } as Omit<Job, 'id'>)

      expect(job.createdAt).toEqual(auditDate)
    })

    it('should apply beforeInsert on insertMany', async () => {
      const ids = await hookedRepository.insertMany<number[]>([
        { name: 'Job 1' } as Omit<Job, 'id'>,
        { name: 'Job 2', createdAt: new Date('2020-01-01T00:00:00Z') },
      ])

      expect(ids).toHaveLength(2)

      const jobs = await hookedRepository.findAll({ sort: { id: 'asc' } })
      expect(jobs[0].createdAt).toEqual(auditDate)
      expect(jobs[1].createdAt).toEqual(auditDate)
    })

    it('should apply beforeUpdate on updateOne', async () => {
      const job = await hookedRepository.insert({ name: 'Original', createdAt: new Date() })

      if (!job?.id) throw new Error('Job not found')

      const condition = ConditionBuilder.create({ id: job.id }).build()
      const updated = await hookedRepository.updateOne(condition, { name: 'Changed' })

      expect(updated.name).toBe('modified:Changed')
    })

    it('should apply beforeUpdate on update', async () => {
      const job = await hookedRepository.insert({ name: 'Original', createdAt: new Date() })

      if (!job?.id) throw new Error('Job not found')

      const condition = ConditionBuilder.create({ id: job.id }).build()
      const count = await hookedRepository.update(condition, { name: 'Changed' })

      expect(count).toBe(1)

      const found = await hookedRepository.findOne(condition)
      expect(found?.name).toBe('modified:Changed')
    })

    it('should apply beforeInsert on bulkInsert', async () => {
      const stream = jsonToStream<Job>([{ name: 'Bulk 1' } as Job, { name: 'Bulk 2', createdAt: new Date('2020-01-01T00:00:00Z') }])

      const count = await hookedRepository.bulkInsert(stream)
      expect(count).toBe(2)

      const jobs = await hookedRepository.findAll({ sort: { name: 'asc' } })
      expect(jobs).toHaveLength(2)
      expect(jobs[0].createdAt).toEqual(auditDate)
      expect(jobs[1].createdAt).toEqual(auditDate)
    })

    it('should work without hooks (no-op)', async () => {
      const job = await repositoryJob.insert({ name: 'No Hooks', createdAt: new Date('2024-05-05') })

      expect(job.name).toBe('No Hooks')
      expect(job.createdAt).toEqual(new Date('2024-05-05'))
    })
  })
})

//region Class helpers

// Test Entity
@Entity({ tableName: 'test_users' })
class UserEntity extends BaseEntity {
  @Property({ primary: true })
  email: string = ''

  @Property()
  name: string = ''

  @Property()
  age: number = 0

  @Property({ fieldName: 'is_active', default: true })
  isActive: boolean = true

  @Property({ fieldName: 'created_at' })
  createdAt: Date = new Date()

  @Property({ nullable: true })
  bio?: string
}

@Entity({ tableName: 'test_jobs' })
class JobEntity extends BaseEntity {
  @PrimaryKey({ autoincrement: true })
  id?: number

  @Property()
  name: string = ''

  @Property({ fieldName: 'created_at' })
  createdAt: Date = new Date()
}

// Domain Entity
interface User {
  email: string
  name: string
  age: number
  isActive: boolean
  createdAt: Date
  bio?: string
}

interface Job {
  id?: number
  name: string
  createdAt: Date
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

//endregion
