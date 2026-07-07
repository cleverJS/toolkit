import { AdapterType, ConditionAdapterRegistry, MikroOrmConditionAdapter } from '@cleverjs/condition-builder'
import { describe, expect, it } from 'vitest'

import { buildPrimaryKeyCondition } from '../../src'

// Serializing to a MikroORM filter is the cheapest way to assert what the
// built Condition actually matches.
const registry = new ConditionAdapterRegistry()
registry.register(AdapterType.MIKROORM, new MikroOrmConditionAdapter())

function toFilter(condition: ReturnType<typeof buildPrimaryKeyCondition>): unknown {
  return registry.getSerializer(AdapterType.MIKROORM).serialize(condition)
}

describe('buildPrimaryKeyCondition', () => {
  describe('single-column primary key', () => {
    it('should build an equality condition from a scalar', () => {
      const condition = buildPrimaryKeyCondition(['id'], 42)
      expect(toFilter(condition)).toEqual({ id: 42 })
    })

    it('should accept string and Date scalars', () => {
      const createdAt = new Date('2024-01-01')
      expect(toFilter(buildPrimaryKeyCondition(['email'], 'a@b.c'))).toEqual({ email: 'a@b.c' })
      expect(toFilter(buildPrimaryKeyCondition(['createdAt'], createdAt))).toEqual({ createdAt })
    })

    it('should accept the object form for a single-column key', () => {
      const condition = buildPrimaryKeyCondition(['id'], { id: 7 })
      expect(toFilter(condition)).toEqual({ id: 7 })
    })
  })

  describe('composite primary key', () => {
    it('should build an equality condition over every key column', () => {
      const condition = buildPrimaryKeyCondition(['orderId', 'productId'], { orderId: 1, productId: 2 })
      expect(toFilter(condition)).toEqual({ $and: [{ orderId: 1 }, { productId: 2 }] })
    })

    it('should reject a scalar value', () => {
      expect(() => buildPrimaryKeyCondition(['orderId', 'productId'], 1)).toThrow('Composite primary key [orderId, productId] requires an object')
    })

    it('should reject a payload missing a key column', () => {
      expect(() => buildPrimaryKeyCondition(['orderId', 'productId'], { orderId: 1 })).toThrow(
        'Missing or null value for primary key column "productId"'
      )
    })
  })

  describe('misuse guards', () => {
    it('should throw when the repository has no primary key configured', () => {
      expect(() => buildPrimaryKeyCondition(undefined, 1)).toThrow('Repository has no primary key configured')
      expect(() => buildPrimaryKeyCondition([], 1)).toThrow('Repository has no primary key configured')
    })

    it('should throw on null and undefined ids instead of matching all rows', () => {
      expect(() => buildPrimaryKeyCondition(['id'], null as never)).toThrow('must not be null or undefined')
      expect(() => buildPrimaryKeyCondition(['id'], undefined as never)).toThrow('must not be null or undefined')
    })

    it('should throw on an empty object payload', () => {
      expect(() => buildPrimaryKeyCondition(['id'], {})).toThrow('Missing or null value for primary key column "id"')
    })

    it('should throw on a null value inside the object payload', () => {
      expect(() => buildPrimaryKeyCondition(['id'], { id: null as never })).toThrow('Missing or null value for primary key column "id"')
    })

    it('should reject keys that are not part of the primary key', () => {
      expect(() => buildPrimaryKeyCondition(['id'], { id: 1, name: 'x' as never })).toThrow('Unexpected key "name" in primary key payload')
    })
  })

  // Ids often arrive as deserialized JSON typed `any` — operator objects and
  // arrays must throw instead of reaching ConditionBuilder as $ne/$in filters.
  describe('injection guards (untyped payloads)', () => {
    it('should reject an operator object as a column value', () => {
      expect(() => buildPrimaryKeyCondition(['id'], { id: { $ne: 0 } as never })).toThrow(
        'Primary key value for column "id" must be a string, number, or Date'
      )
    })

    it('should reject an array as a column value', () => {
      expect(() => buildPrimaryKeyCondition(['id'], { id: [1, 2, 3] as never })).toThrow(
        'Primary key value for column "id" must be a string, number, or Date'
      )
    })

    it('should reject a bare array payload', () => {
      expect(() => buildPrimaryKeyCondition(['id'], [1, 2, 3] as never)).toThrow(
        'Primary key value for column "id" must be a string, number, or Date'
      )
    })

    it('should reject an operator value inside a composite payload', () => {
      expect(() => buildPrimaryKeyCondition(['a', 'b'], { a: 1, b: { $ne: 0 } as never })).toThrow(
        'Primary key value for column "b" must be a string, number, or Date'
      )
    })

    it('should reject a boolean value', () => {
      expect(() => buildPrimaryKeyCondition(['id'], true as never)).toThrow('Primary key value for column "id" must be a string, number, or Date')
    })
  })
})
