import { describe, expect, it } from 'vitest'

// Strategies and the brand are part of the public API — imported from the
// package root on purpose (they used to be internal-only, making setCloner
// unusable for consumers).
import { CLONEABLE, Cloner, ICloneable, JSONCloner, StructuredCloner } from '../../src'

describe('Cloner', () => {
  function cloner(type: 'json' | 'structured') {
    return new Cloner(type === 'json' ? new JSONCloner() : new StructuredCloner())
  }

  it('should keep Date type with StructuredCloner', () => {
    const item = { date: new Date() }
    expect(item.date).toBeInstanceOf(Date)
    const clone = cloner('structured').clone(item)
    expect(clone.date).toBeInstanceOf(Date)
  })

  it('should clone Set', () => {
    const item = new Set([1])
    expect(item.size).toEqual(1)
    const clone = cloner('structured').clone(item)
    clone.clear()
    expect(item.size).toEqual(1)
    expect(clone.size).toEqual(0)
  })

  it('should keep Date type with JSONCloner', () => {
    const item = { date: new Date() }
    expect(item.date).toBeInstanceOf(Date)
    const clone = cloner('json').clone(item)
    expect(clone.date).toBeInstanceOf(Date)
  })

  it('should clone with StructuredCloner', () => {
    const item = { a: 1, b: { ba: 1, bb: 2 }, c: Buffer.from('ABC') }
    const clone = cloner('structured').clone(item)

    item.a = 2
    item.b.bb = 10
    item.c = Buffer.from('CCC')

    expect(clone.a).toBe(1)
    expect(clone.b).toEqual({ ba: 1, bb: 2 })
    // structuredClone converts Buffer to Uint8Array (standard Web API behavior)
    expect(new Uint8Array(clone.c)).toEqual(new Uint8Array([65, 66, 67]))
    expect(clone).not.toEqual(item)
  })

  it('should clone with JSONCloner', () => {
    const item = { a: 1, b: { ba: 1, bb: 2 }, c: Buffer.from('ABC') }

    const clone = cloner('json').clone(item)

    item.a = 2
    item.b.bb = 10
    item.c = Buffer.from('CCC')

    expect(clone).toEqual({ a: 1, b: { ba: 1, bb: 2 }, c: Buffer.from('ABC') })
    expect(clone).not.toEqual(item)
  })

  it('should clone Buffer as Uint8Array', () => {
    const obj = Buffer.from([1, 2, 3])
    const cloned = cloner('structured').clone(obj)

    expect(obj).toBeInstanceOf(Buffer)
    // structuredClone converts Buffer to Uint8Array
    expect(cloned).toBeInstanceOf(Uint8Array)
    expect(new Uint8Array(cloned)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('should accept a strategy via constructor without touching the shared singleton', () => {
    const jsonInstance = new Cloner(new JSONCloner())
    const shared = Cloner.getInstance()

    const item = { date: new Date(), set: new Set([1]) }
    const fromInjected = jsonInstance.clone(item)
    const fromShared = shared.clone(item)

    expect(fromInjected.date).toBeInstanceOf(Date)
    expect(fromInjected.set).toEqual({}) // JSON.stringify collapses Set — JSON strategy signature
    expect(fromShared.set).toBeInstanceOf(Set) // structuredClone keeps Set — shared default untouched
  })

  it('should keep the deprecated setCloner working for existing consumers', () => {
    const instance = new Cloner()
    // eslint-disable-next-line sonarjs/deprecation -- back-compat coverage for the deprecated API
    instance.setCloner(new JSONCloner())

    const clone = instance.clone({ set: new Set([1]) })
    expect(clone.set).toEqual({}) // JSON strategy took effect
  })

  it('should default to StructuredCloner when constructed without arguments', () => {
    const instance = new Cloner()
    const clone = instance.clone({ set: new Set([1, 2]) })
    expect(clone.set).toBeInstanceOf(Set)
    expect(clone.set.size).toBe(2)
  })

  it('should use clone() of a branded ICloneable implementation', () => {
    class MyEntity implements ICloneable {
      readonly [CLONEABLE] = true
      public constructor(public value: number) {}
      clone(): this {
        return new MyEntity(this.value + 100) as this
      }
    }

    const clone = cloner('structured').clone(new MyEntity(1))
    expect(clone).toBeInstanceOf(MyEntity)
    expect(clone.value).toBe(101)
  })

  // Regression: any object with a prototype clone() method used to be treated
  // as ICloneable, silently substituting foreign clone() semantics for a deep
  // clone (knex QueryBuilder, moment, ...).
  it('should NOT call clone() of an unbranded object and deep-clone it instead', () => {
    class QueryBuilderLike {
      public state = { limit: 10 }
      clone(): string {
        return 'hijacked'
      }
    }

    const result = cloner('structured').clone(new QueryBuilderLike())
    expect(result).not.toBe('hijacked')
    expect(result.state).toEqual({ limit: 10 })
  })
})
