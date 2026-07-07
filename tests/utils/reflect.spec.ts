import { describe, expect, it } from 'vitest'

import { CLONEABLE } from '../../src'
import { isInstanceOfICloneable } from '../../src/utils/clone/reflect'

describe('isInstanceOfICloneable', () => {
  it('should return true for a branded class with clone()', () => {
    class MyCloneable {
      readonly [CLONEABLE] = true
      clone() {
        return new MyCloneable()
      }
    }
    expect(isInstanceOfICloneable(new MyCloneable())).toBe(true)
  })

  it('should return true for a branded plain object with clone()', () => {
    const obj = {
      [CLONEABLE]: true as const,
      clone() {
        return this
      },
    }
    expect(isInstanceOfICloneable(obj)).toBe(true)
  })

  // Regression: detection used to duck-type on a `clone()` method anywhere in
  // the prototype chain, hijacking third-party objects (knex QueryBuilder,
  // moment, ...) whose clone() has entirely different semantics.
  it('should return false for an unbranded class with clone()', () => {
    class QueryBuilderLike {
      clone() {
        return 'not a deep clone'
      }
    }
    expect(isInstanceOfICloneable(new QueryBuilderLike())).toBe(false)
  })

  it('should return false when the brand is present but clone is not a function', () => {
    expect(isInstanceOfICloneable({ [CLONEABLE]: true, clone: 42 })).toBe(false)
  })

  it('should return false when the brand value is not exactly true', () => {
    expect(isInstanceOfICloneable({ [CLONEABLE]: 1, clone: () => ({}) })).toBe(false)
  })

  it('should return false for objects without clone, primitives, and nullish', () => {
    expect(isInstanceOfICloneable({ a: 1 })).toBe(false)
    expect(isInstanceOfICloneable(null)).toBe(false)
    expect(isInstanceOfICloneable(undefined)).toBe(false)
    expect(isInstanceOfICloneable('clone')).toBe(false)
    expect(isInstanceOfICloneable(42)).toBe(false)
  })
})
