import { AdapterType, Condition, ConditionAdapterRegistry, ConditionBuilder, KnexConditionAdapter } from '@cleverJS/condition-builder'
import knex, { Knex } from 'knex'
import { PropertySchema } from 'src/utils/types/types'
import { PassThrough } from 'stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { IMapper, KnexConnectionScope, KnexRepository, Paginator } from '../../src'

describe('KnexRepository', () => {
  let db: Knex
  let scope: KnexConnectionScope
  let repository: KnexRepository<UserDBEntity, User>
  let repositoryJob: KnexRepository<JobDBEntity, Job, 'id'>

  beforeAll(async () => {
    const conditionAdapterRegistry = ConditionAdapterRegistry.getInstance()
    conditionAdapterRegistry.register(AdapterType.KNEX, new KnexConditionAdapter())

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

    await db.schema.dropTableIfExists('test_knex_users')
    await db.schema.dropTableIfExists('test_knex_jobs')

    await db.schema.createTable('test_knex_users', (table) => {
      table.string('email').primary()
      table.string('name').notNullable()
      table.integer('age').notNullable()
      table.boolean('is_active').notNullable().defaultTo(true)
      table.timestamp('created_at', { useTz: false }).notNullable()
      table.string('bio').nullable()
    })

    await db.schema.createTable('test_knex_jobs', (table) => {
      table.increments('id').primary()
      table.string('name').notNullable()
      table.timestamp('created_at', { useTz: false }).notNullable()
    })

    scope = new KnexConnectionScope(db)

    repository = new KnexRepository<UserDBEntity, User>(scope, new UserMapper(), {
      table: 'test_knex_users',
      primary: ['email'],
    })

    repositoryJob = new KnexRepository<JobDBEntity, Job, 'id'>(scope, new JobMapper(), {
      table: 'test_knex_jobs',
      primary: ['id'],
    })
  })

  afterAll(async () => {
    await db.schema.dropTableIfExists('test_knex_users')
    await db.schema.dropTableIfExists('test_knex_jobs')
    await db.destroy()
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE TABLE ?? CASCADE', ['test_knex_users'])
    await db.raw('TRUNCATE TABLE ?? CASCADE', ['test_knex_jobs'])
  })

  describe('insert', () => {
    it('should insert a single user', async () => {
      const userData: User = {
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
      const userData: User = {
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
    it('should insert multiple users and return inserted rows', async () => {
      const result = await repositoryJob.insertMany<JobDBEntity[]>([
        { name: 'Job 1', createdAt: new Date() },
        { name: 'Job 2', createdAt: new Date() },
      ])

      expect(result).toHaveLength(2)

      const count = await repositoryJob.count()
      expect(count).toBe(2)
    })

    it('should return empty array for empty input', async () => {
      const result = await repository.insertMany<UserDBEntity[]>([])
      expect(result).toEqual([])
    })
  })

  describe('findOne', () => {
    it('should find user by email condition', async () => {
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

      const condition: Condition = ConditionBuilder.create({ age: { $lt: 20 }, is_active: true }).build()
      const user = await repository.findOne(condition)

      expect(user).toBeDefined()
      expect(user?.age).toBe(18)
    })
  })

  describe('findAll', () => {
    beforeEach(async () => {
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
      const condition: Condition = ConditionBuilder.create({ is_active: true }).build()
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

  describe('findPartial', () => {
    beforeEach(async () => {
      await repository.insertMany([
        { email: 'partial1@example.com', name: 'Partial 1', age: 25, isActive: true, createdAt: new Date() },
        { email: 'partial2@example.com', name: 'Partial 2', age: 30, isActive: false, createdAt: new Date() },
      ])
    })

    it('should return only selected fields', async () => {
      const result = await repository.findPartial<{ email: string; name: string }>({
        select: ['email', 'name'],
        sort: { email: 'asc' },
      })

      expect(result).toHaveLength(2)
      expect(result[0].email).toBeDefined()
      expect(result[0].name).toBeDefined()
      expect((result[0] as Record<string, unknown>).age).toBeUndefined()
    })

    it('should apply condition with select', async () => {
      const condition: Condition = ConditionBuilder.create({ is_active: true }).build()
      const result = await repository.findPartial<{ email: string }>({
        select: ['email'],
        condition,
      })

      expect(result).toHaveLength(1)
      expect(result[0].email).toBe('partial1@example.com')
    })

    it('should throw error when using paginator without sort', async () => {
      const paginator = new Paginator({ page: 1, perPage: 2 })

      await expect(repository.findPartial({ select: ['email'], paginator })).rejects.toThrow('Sort is required when paginator is used')
    })
  })

  describe('count', () => {
    beforeEach(async () => {
      const users: User[] = [
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
      const condition: Condition = ConditionBuilder.create({ is_active: true }).build()
      const count = await repository.count(condition)

      expect(count).toBe(2)
    })

    it('should return 0 for empty table', async () => {
      await db.raw('TRUNCATE TABLE ?? CASCADE', ['test_knex_users'])
      const count = await repository.count()

      expect(count).toBe(0)
    })

    it('should count with complex condition', async () => {
      const condition: Condition = ConditionBuilder.create({ age: { $gte: 25 }, is_active: true }).build()

      const count = await repository.count(condition)

      expect(count).toBe(1)
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

      const updatedUser = await repository.updateOne(condition, { name: 'Updated Name', age: 26 })

      expect(updatedUser.name).toBe('Updated Name')
      expect(updatedUser.age).toBe(26)
      expect(updatedUser.email).toBe('update@example.com')
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

  describe('update', () => {
    it('should update multiple rows and return count', async () => {
      await repository.insertMany([
        { email: 'u1@example.com', name: 'User 1', age: 25, isActive: true, createdAt: new Date() },
        { email: 'u2@example.com', name: 'User 2', age: 30, isActive: true, createdAt: new Date() },
        { email: 'u3@example.com', name: 'User 3', age: 35, isActive: false, createdAt: new Date() },
      ])

      const condition: Condition = ConditionBuilder.create({ is_active: true }).build()
      const count = await repository.update(condition, { age: 99 })

      expect(count).toBe(2)

      const allUsers = await repository.findAll({ sort: { email: 'asc' } })
      expect(allUsers.filter((u) => u.age === 99)).toHaveLength(2)
      expect(allUsers.find((u) => !u.isActive)?.age).toBe(35)
    })

    it('should return 0 when no rows match', async () => {
      const condition: Condition = ConditionBuilder.create({ email: 'nonexistent@example.com' }).build()
      const count = await repository.update(condition, { name: 'Updated' })

      expect(count).toBe(0)
    })
  })

  describe('delete', () => {
    it('should delete users by condition', async () => {
      await repository.insertMany([
        { email: 'delete1@example.com', name: 'Delete 1', age: 25, isActive: true, createdAt: new Date() },
        { email: 'delete2@example.com', name: 'Delete 2', age: 30, isActive: true, createdAt: new Date() },
        { email: 'keep@example.com', name: 'Keep', age: 35, isActive: false, createdAt: new Date() },
      ])

      const condition: Condition = ConditionBuilder.create({ is_active: true }).build()
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
      const users: User[] = [
        { email: 'stream1@example.com', name: 'Stream 1', age: 20, isActive: true, createdAt: new Date('2024-01-01') },
        { email: 'stream2@example.com', name: 'Stream 2', age: 30, isActive: true, createdAt: new Date('2024-01-02') },
        {
          email: 'stream3@example.com',
          name: 'Stream 3',
          age: 40,
          isActive: false,
          createdAt: new Date('2024-01-03'),
        },
      ]

      await repository.insertMany(users)
    })

    it('should stream all users', async () => {
      const stream = repository.stream<User>({
        select: ['email', 'name', 'age', 'is_active', 'created_at', 'bio'],
        sort: { age: 'asc' },
      })
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
      const stream = repository.stream<User>({
        select: ['email', 'name', 'age', 'is_active', 'created_at', 'bio'],
        condition,
        sort: { age: 'asc' },
      })
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
        select: ['email', 'name', 'age', 'is_active', 'created_at', 'bio'],
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

      expect(() =>
        repository.stream({
          select: ['email'],
          paginator,
        })
      ).toThrow('Sort is required when paginator is used')
    })
  })

  describe('bulkInsert', () => {
    it('should bulk insert users from stream', async () => {
      const users: User[] = [
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
      const stream = jsonToStream<User>([])
      const insertedCount = await repository.bulkInsert(stream)

      expect(insertedCount).toBe(0)
    })

  })

  describe('primary key', () => {
    it('should expose primary key information', () => {
      expect(repository.primary).toEqual(['email'])
      expect(repositoryJob.primary).toEqual(['id'])
    })
  })

  describe('auto-increment primary key', () => {
    it('should insert and return auto-incremented id', async () => {
      const job = await repositoryJob.insert({
        name: 'Test Job',
        createdAt: new Date(),
      })

      expect(job.id).toBeDefined()
      expect(typeof job.id).toBe('number')
      expect(job.name).toBe('Test Job')
    })

    it('should find job by id', async () => {
      const job = await repositoryJob.insert({
        name: 'Find Job',
        createdAt: new Date(),
      })

      if (!job.id) throw new Error('Job id is undefined')

      const condition: Condition = ConditionBuilder.create({ id: job.id }).build()
      const found = await repositoryJob.findOne(condition)

      expect(found).toBeDefined()
      expect(found?.name).toBe('Find Job')
    })

    it('should update job by id', async () => {
      const job = await repositoryJob.insert({
        name: 'Update Job',
        createdAt: new Date(),
      })

      if (!job.id) throw new Error('Job id is undefined')

      const condition: Condition = ConditionBuilder.create({ id: job.id }).build()
      const updated = await repositoryJob.updateOne(condition, { name: 'Updated Job' })

      expect(updated.name).toBe('Updated Job')
      expect(updated.id).toBe(job.id)
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
        const stream = jsonToStream<User>([
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
          const stream = jsonToStream<User>([
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
  })
})

//region Class helpers

// DB entity types (matching actual DB column names)
interface UserDBEntity extends Record<string, unknown> {
  email: string
  name: string
  age: number
  is_active: boolean
  created_at: Date
  bio?: string
}

interface JobDBEntity extends Record<string, unknown> {
  id?: number
  name: string
  created_at: Date
}

// Domain types (camelCase)
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

// Mappers
class UserMapper implements IMapper<User, UserDBEntity> {
  toPersistence(domain: Partial<PropertySchema<User>>): Partial<UserDBEntity> {
    const entity: Partial<UserDBEntity> = {}

    if (domain.email !== undefined) entity.email = domain.email
    if (domain.name !== undefined) entity.name = domain.name
    if (domain.age !== undefined) entity.age = domain.age
    if (domain.isActive !== undefined) entity.is_active = domain.isActive
    if (domain.createdAt !== undefined) entity.created_at = domain.createdAt
    if (domain.bio !== undefined) entity.bio = domain.bio

    return entity
  }

  toDomain(entity: UserDBEntity): User {
    return {
      email: entity.email,
      name: entity.name,
      age: entity.age,
      isActive: entity.is_active,
      createdAt: entity.created_at,
      bio: entity.bio,
    }
  }

  toEntity(domain: Partial<User>): UserDBEntity {
    return {
      email: domain.email || '',
      name: domain.name || '',
      age: domain.age || 0,
      is_active: domain.isActive !== undefined ? domain.isActive : true,
      created_at: domain.createdAt || new Date(),
      bio: domain.bio,
    }
  }
}

class JobMapper implements IMapper<Job, JobDBEntity> {
  toPersistence(domain: Partial<PropertySchema<Job>>): Partial<JobDBEntity> {
    const entity: Partial<JobDBEntity> = {}

    if (domain.id !== undefined) entity.id = domain.id
    if (domain.name !== undefined) entity.name = domain.name
    if (domain.createdAt !== undefined) entity.created_at = domain.createdAt

    return entity
  }

  toDomain(entity: JobDBEntity): Job {
    return {
      id: entity.id,
      name: entity.name,
      createdAt: entity.created_at,
    }
  }

  toEntity(domain: Partial<Job>): JobDBEntity {
    const entity: JobDBEntity = {
      name: domain.name || '',
      created_at: domain.createdAt || new Date(),
    }

    if (domain.id !== undefined) {
      entity.id = domain.id
    }

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

//endregion
