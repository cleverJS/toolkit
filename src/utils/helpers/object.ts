export function removeNullish<T extends Record<string, any>>(obj: T): Partial<T> {
  const entries = Object.entries(obj).filter(([_, v]) => v != null)
  return Object.fromEntries(entries) as Partial<T>
}

export function removeUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const entries = Object.entries(obj).filter(([_, v]) => v !== undefined)
  return Object.fromEntries(entries) as Partial<T>
}

export function getKeyByValue<T extends { [index: string]: string | number }>(enumObj: T, value: string | number): keyof T | null {
  for (const key in enumObj) {
    if (Object.prototype.hasOwnProperty.call(enumObj, key) && enumObj[key] === value) {
      return key
    }
  }
  return null
}

/**
 * Checks if an object is empty or contains only null/undefined values (recursively).
 * Note: `{ a: null }` is considered empty.
 */
export function isEmptyObject(obj: Record<string, unknown>): boolean {
  if (obj == null) {
    return true
  }
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key]
      if (value == null) {
        continue
      }
      if (typeof value === 'object') {
        if (!isEmptyObject(value as Record<string, unknown>)) {
          return false
        }
      } else {
        return false
      }
    }
  }
  return true
}

export function intersect(setA: Set<any>, setB: Set<any>) {
  return new Set([...setA].filter((x) => setB.has(x)))
}
