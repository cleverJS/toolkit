import { describe, expect, it } from 'vitest'

import { Cloner } from '../../src'
import { JSONCloner } from '../../src/utils/clone/strategy/JSONCloner'
import { StructuredCloner } from '../../src/utils/clone/strategy/StructuredCloner'

describe('Cloner', () => {
  function cloner(type: 'json' | 'structured') {
    const instance = Cloner.getInstance()
    if (type === 'json') {
      instance.setCloner(new JSONCloner())
    }

    if (type === 'structured') {
      instance.setCloner(new StructuredCloner())
    }
    return instance
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
})
