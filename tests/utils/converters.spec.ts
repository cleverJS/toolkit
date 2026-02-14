import { describe, expect, it } from 'vitest'

import { convertToBoolean } from '../../src'

describe('convertToBoolean', () => {
  it('should return false for null', () => {
    expect(convertToBoolean(null)).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(convertToBoolean(undefined)).toBe(false)
  })

  it('should pass through boolean true', () => {
    expect(convertToBoolean(true)).toBe(true)
  })

  it('should pass through boolean false', () => {
    expect(convertToBoolean(false)).toBe(false)
  })

  it('should convert number 1 to true', () => {
    expect(convertToBoolean(1)).toBe(true)
  })

  it('should convert number 0 to false', () => {
    expect(convertToBoolean(0)).toBe(false)
  })

  it('should throw for number other than 0 or 1', () => {
    expect(() => convertToBoolean(2)).toThrow("Not convertible boolean value '2'")
    expect(() => convertToBoolean(-1)).toThrow("Not convertible boolean value '-1'")
  })

  it.each(['yes', 'y', 'true', 't', '1', 'YES', 'True', ' Yes '])('should convert truthy string "%s" to true', (v) => {
    expect(convertToBoolean(v)).toBe(true)
  })

  it.each(['no', 'n', 'false', 'f', '0', 'null', 'undefined', 'NO', 'False', ' No '])('should convert falsy string "%s" to false', (v) => {
    expect(convertToBoolean(v)).toBe(false)
  })

  it('should throw for unrecognized string', () => {
    expect(() => convertToBoolean('maybe')).toThrow("Not convertible boolean value 'maybe'")
  })

  it('should throw for unsupported type', () => {
    expect(() => convertToBoolean({})).toThrow("Not convertible boolean value of type 'object'")
    expect(() => convertToBoolean([])).toThrow("Not convertible boolean value of type 'object'")
  })
})
