import { describe, expect, it } from 'vitest'
import { Cloner } from '../../src'
import { JSONCloner } from '../../src/utils/clone/strategy/JSONCloner'
import { V8Cloner } from '../../src/utils/clone/strategy/V8Cloner'


describe('Cloner', () => {
  function cloner(type: 'json' | 'v8') {
    const instance = Cloner.getInstance()
    if (type === 'json') {
      instance.setCloner(new JSONCloner())
    }

    if (type === 'v8') {
      instance.setCloner(new V8Cloner())
    }
    return instance
  }

  it('should keep Date type with V8Cloner', () => {
    const item = { date: new Date() }
    expect(item.date).toBeInstanceOf(Date)
    const clone = cloner('v8').clone(item)
    expect(clone.date).toBeInstanceOf(Date)
  })

  it('should clone Set', () => {
    const item = new Set([1])
    expect(item.size).toEqual(1)
    const clone = cloner('v8').clone(item)
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

  it('should clone with V8Cloner', () => {
    const item = { a: 1, b: { ba: 1, bb: 2 }, c: Buffer.from('ABC') }
    const clone = cloner('v8').clone(item)

    item.a = 2
    item.b.bb = 10
    item.c = Buffer.from('CCC')

    expect(clone).toEqual({ a: 1, b: { ba: 1, bb: 2 }, c: Buffer.from('ABC') })
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

  it('should clone Buffer', async () => {
    const obj = Buffer.from([1, 2, 3])
    const cloned = cloner('v8').clone(obj)

    expect(obj).toBeInstanceOf(Buffer)
    expect(cloned).toBeInstanceOf(Buffer)
  })
})
