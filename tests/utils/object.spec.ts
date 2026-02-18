import { describe, expect, it } from 'vitest'

import { getKeyByValue, intersect, isEmptyObject, isPlainObject, removeNullish, removeUndefined } from '../../src'

describe('removeNullish', () => {
  it('should remove null and undefined values', () => {
    expect(removeNullish({ a: 1, b: null, c: undefined, d: 'hello' })).toEqual({ a: 1, d: 'hello' })
  })

  it('should keep falsy non-nullish values', () => {
    expect(removeNullish({ a: 0, b: '', c: false })).toEqual({ a: 0, b: '', c: false })
  })

  it('should return empty object when all values are nullish', () => {
    expect(removeNullish({ a: null, b: undefined })).toEqual({})
  })

  it('should return same shape when no nullish values', () => {
    expect(removeNullish({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
  })
})

describe('removeUndefined', () => {
  it('should remove undefined values but keep null', () => {
    expect(removeUndefined({ a: 1, b: null, c: undefined })).toEqual({ a: 1, b: null })
  })

  it('should return same shape when no undefined values', () => {
    expect(removeUndefined({ a: 1, b: null })).toEqual({ a: 1, b: null })
  })
})

describe('getKeyByValue', () => {
  it('should find key by string value', () => {
    const obj = { FOO: 'foo', BAR: 'bar' } as const
    expect(getKeyByValue(obj, 'foo')).toBe('FOO')
  })

  it('should find key by numeric value', () => {
    const obj = { A: 1, B: 2, C: 3 } as const
    expect(getKeyByValue(obj, 2)).toBe('B')
  })

  it('should return null when value not found', () => {
    const obj = { A: 1, B: 2 } as const
    expect(getKeyByValue(obj, 99)).toBeNull()
  })

  it('should return first matching key', () => {
    const obj = { X: 'same', Y: 'same' }
    const result = getKeyByValue(obj, 'same')
    expect(['X', 'Y']).toContain(result)
  })
})

describe('isEmptyObject', () => {
  it('should return true for empty object', () => {
    expect(isEmptyObject({})).toBe(true)
  })

  it('should return true for null', () => {
    expect(isEmptyObject(null as any)).toBe(true)
  })

  it('should return true for object with only null values', () => {
    expect(isEmptyObject({ a: null })).toBe(true)
  })

  it('should return true for object with only undefined values', () => {
    expect(isEmptyObject({ a: undefined })).toBe(true)
  })

  it('should return true for nested empty objects', () => {
    expect(isEmptyObject({ a: { b: null, c: { d: undefined } } })).toBe(true)
  })

  it('should return false for object with non-nullish value', () => {
    expect(isEmptyObject({ a: 1 })).toBe(false)
  })

  it('should return false for object with falsy non-nullish value', () => {
    expect(isEmptyObject({ a: 0 })).toBe(false)
    expect(isEmptyObject({ a: '' })).toBe(false)
    expect(isEmptyObject({ a: false })).toBe(false)
  })

  it('should return false when nested object has a value', () => {
    expect(isEmptyObject({ a: { b: null, c: { d: 42 } } })).toBe(false)
  })
})

describe('isPlainObject', () => {
  it('should return true for empty object literal', () => {
    expect(isPlainObject({})).toBe(true)
  })

  it('should return true for object with properties', () => {
    expect(isPlainObject({ a: 1, b: 'hello' })).toBe(true)
  })

  it('should return true for Object.create(null)', () => {
    expect(isPlainObject(Object.create(null))).toBe(true)
  })

  it('should return false for class instance', () => {
    class Foo {
      x = 1
    }
    expect(isPlainObject(new Foo())).toBe(false)
  })

  it('should return false for array', () => {
    expect(isPlainObject([1, 2, 3])).toBe(false)
  })

  it('should return false for null', () => {
    expect(isPlainObject(null)).toBe(false)
  })

  it('should return false for Date', () => {
    expect(isPlainObject(new Date())).toBe(false)
  })

  it('should return false for primitives', () => {
    expect(isPlainObject(42)).toBe(false)
    expect(isPlainObject('string')).toBe(false)
    expect(isPlainObject(true)).toBe(false)
    expect(isPlainObject(undefined)).toBe(false)
  })
})

describe('intersect', () => {
  it('should return common elements', () => {
    const result = intersect(new Set([1, 2, 3]), new Set([2, 3, 4]))
    expect(result).toEqual(new Set([2, 3]))
  })

  it('should return empty set when no overlap', () => {
    const result = intersect(new Set([1, 2]), new Set([3, 4]))
    expect(result).toEqual(new Set())
  })

  it('should handle empty sets', () => {
    expect(intersect(new Set(), new Set([1, 2]))).toEqual(new Set())
    expect(intersect(new Set([1, 2]), new Set())).toEqual(new Set())
  })
})
