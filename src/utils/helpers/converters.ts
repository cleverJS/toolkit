export function convertToBoolean(v: any): boolean {
  // Handle null/undefined
  if (v == null) {
    return false
  }

  // Handle boolean
  if (typeof v === 'boolean') {
    return v
  }

  // Handle number
  if (typeof v === 'number') {
    if ([0, 1].includes(v)) {
      return v === 1
    }
    throw new Error(`Not convertible boolean value '${v}'. Only 0 and 1 are accepted.`)
  }

  // Handle string
  if (typeof v === 'string') {
    const normalized = v.trim().toLowerCase()

    if (['yes', 'y', 'true', 't', '1'].includes(normalized)) {
      return true
    }
    if (['no', 'n', 'false', 'f', '0', 'null', 'undefined'].includes(normalized)) {
      return false
    }

    throw new Error(`Not convertible boolean value '${v}'`)
  }

  throw new Error(`Not convertible boolean value of type '${typeof v}'`)
}
