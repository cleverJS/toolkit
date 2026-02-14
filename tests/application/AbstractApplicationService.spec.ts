import { ConditionBuilder } from '@cleverJS/condition-builder'
import { describe, expect, it, vi } from 'vitest'

import { IRepository, ISort, listWithPagination, Paginator } from '../../src'

interface Item {
  id: number
  name: string
}

function mockRepository(overrides: Partial<IRepository<Item>> = {}): IRepository<Item> {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    findPartial: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    insert: vi.fn(),
    updateOne: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    insertMany: vi.fn(),
    bulkInsert: vi.fn(),
    stream: vi.fn(),
    ...overrides,
  } as IRepository<Item>
}

describe('listWithPagination', () => {
  it('should return items and total', async () => {
    const items = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]
    const repo = mockRepository({
      findAll: vi.fn().mockResolvedValue(items),
      count: vi.fn().mockResolvedValue(10),
    })

    const paginator = new Paginator()

    const result = await listWithPagination(repo, paginator)

    expect(result.items).toEqual(items)
    expect(result.total).toBe(10)
    expect(paginator.getTotal()).toBe(10)
  })

  it('should call count when paginator has no total set', async () => {
    const repo = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(42),
    })

    const paginator = new Paginator()

    await listWithPagination(repo, paginator)

    expect(repo.count).toHaveBeenCalled()
    expect(paginator.getTotal()).toBe(42)
  })

  it('should skip count when paginator already has total', async () => {
    const repo = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(999),
    })

    const paginator = new Paginator()
    paginator.setTotal(50)

    const result = await listWithPagination(repo, paginator)

    expect(repo.count).not.toHaveBeenCalled()
    expect(result.total).toBe(-1)
  })

  it('should skip count when skipTotal is true', async () => {
    const repo = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(999),
    })

    const paginator = new Paginator({ skipTotal: true })

    const result = await listWithPagination(repo, paginator)

    expect(repo.count).not.toHaveBeenCalled()
    expect(result.total).toBe(-1)
  })

  it('should forward condition and sort to findAll', async () => {
    const repo = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    })

    const paginator = new Paginator()
    const condition = ConditionBuilder.create({ name: 'test' }).build()
    const sort: ISort = { name: 'asc' }

    await listWithPagination(repo, paginator, condition, sort)

    expect(repo.findAll).toHaveBeenCalledWith({ condition, paginator, sort })
    expect(repo.count).toHaveBeenCalledWith(condition)
  })
})
