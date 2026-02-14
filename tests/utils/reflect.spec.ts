import { describe, expect, it } from 'vitest'

import { getOwnMethodNames, isInstanceOfICloneable } from '../../src/utils/clone/reflect'

describe('getOwnMethodNames', () => {
  it('should return method names from prototype chain', () => {
    class Foo {
      bar() {}
      baz() {}
    }
    const methods = getOwnMethodNames(new Foo())
    expect(methods.has('bar')).toBe(true)
    expect(methods.has('baz')).toBe(true)
  })

  it('should exclude standard prototype fields', () => {
    const methods = getOwnMethodNames({})
    expect(methods.has('constructor')).toBe(false)
    expect(methods.has('toString')).toBe(false)
    expect(methods.has('hasOwnProperty')).toBe(false)
  })

  it('should collect methods from inheritance chain', () => {
    class Base {
      baseMethod() {}
    }
    class Child extends Base {
      childMethod() {}
    }
    const methods = getOwnMethodNames(new Child())
    expect(methods.has('baseMethod')).toBe(true)
    expect(methods.has('childMethod')).toBe(true)
  })
})

describe('isInstanceOfICloneable', () => {
  it('should return true for class implementing clone via prototype', () => {
    class MyCloneable {
      clone() {
        return new MyCloneable()
      }
    }
    expect(isInstanceOfICloneable(new MyCloneable())).toBe(true)
  })

  it('should return false for plain object with clone as own property', () => {
    // getOwnMethodNames walks the prototype chain, not own properties
    const obj = {
      clone() {
        return this
      },
    }
    expect(isInstanceOfICloneable(obj)).toBe(false)
  })

  it('should return false for object without clone method', () => {
    expect(isInstanceOfICloneable({ a: 1 })).toBe(false)
  })
})
