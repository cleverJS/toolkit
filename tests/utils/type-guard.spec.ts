import { describe, expect, it } from 'vitest'

import { isExactInstanceOf, isInstanceOf, isInstanceOfByCondition } from '../../src/utils/helpers/type-guards'

// Helper type to ensure type predicate works at runtime; we only check boolean behavior here.
describe('typeGuards', () => {
  describe('isInstanceOf with string condition (property in object)', () => {
    it('returns true when object has the property (own or prototype)', () => {
      const base = { protoProp: 1 } as const
      const obj = Object.create(base) as { protoProp: number } & Record<string, unknown>
      Object.assign(obj, { ownProp: 2 })

      expect(isInstanceOf<typeof obj>(obj, 'ownProp')).toBe(true)
      expect(isInstanceOf<typeof obj>(obj, 'protoProp')).toBe(true)
    })

    it('returns false when object is null, non-object, or property missing', () => {
      expect(isInstanceOf<object>(null, 'x')).toBe(false)
      expect(isInstanceOf<object>(undefined as any, 'x')).toBe(false)
      expect(isInstanceOf<object>(42 as any, 'x')).toBe(false)
      expect(isInstanceOf<object>('str' as any, 'lengthX')).toBe(false)
      expect(isInstanceOf<object>({ a: 1 }, 'b')).toBe(false)
    })
  })

  describe('isInstanceOf with predicate function', () => {
    it('returns predicate result (true/false) and passes the argument through', () => {
      const obj = { a: 1 }
      const calls: unknown[] = []
      const predicateTrue = (o: unknown) => {
        calls.push(o)
        return true
      }
      const predicateFalse = () => false

      expect(isInstanceOf<typeof obj>(obj, predicateTrue)).toBe(true)
      expect(isInstanceOf<typeof obj>(obj, predicateFalse)).toBe(false)
      // ensure the predicate got the same object
      expect(calls[0]).toBe(obj)
    })
  })

  describe('isInstanceOfByCondition', () => {
    it('delegates to isInstanceOf (behavior parity)', () => {
      const obj = { a: 1 }
      const predicate = (o: unknown) => typeof o === 'object' && o !== null && 'a' in (o as any)

      expect(isInstanceOfByCondition<typeof obj>(obj, predicate)).toBe(true)
      expect(isInstanceOfByCondition<typeof obj>({}, predicate)).toBe(false)
    })
  })

  describe('isInstanceOfError', () => {
    it('identifies built-in Error subclasses correctly', () => {
      const err = new TypeError('oops')
      const other = new Error('nope')

      expect(isExactInstanceOf(err, TypeError)).toBe(true)
      expect(isExactInstanceOf(other, TypeError)).toBe(false)
    })
  })
})
