import { Condition, ConditionBuilder } from '@cleverjs/condition-builder'

import { isPlainObject } from '../utils/helpers/object'

export type TPrimaryKeyValue = string | number | Date

/**
 * Accepted by findById/updateById/deleteById: a scalar for a single-column
 * primary key, or a `{ column: value }` object for composite keys. Object keys
 * must match `repository.primary` exactly (DB-side column / entity property
 * names — the same names findOne uses for its default sort).
 */
export type TPrimaryKeyPayload = TPrimaryKeyValue | Readonly<Record<string, TPrimaryKeyValue>>

/**
 * Builds an equality Condition over the repository's primary key. Every
 * invalid payload throws instead of degrading to a broader filter — a
 * condition silently missing a key column would make deleteById/updateById
 * affect rows the caller never targeted.
 */
export function buildPrimaryKeyCondition(primary: readonly string[] | undefined, id: TPrimaryKeyPayload): Condition {
  if (!primary?.length) {
    throw new Error(
      'Repository has no primary key configured — findById/updateById/deleteById require it. Configure `primary` in the repository config.'
    )
  }

  if (id == null) {
    throw new Error(`Primary key value must not be null or undefined (primary key: [${primary.join(', ')}])`)
  }

  if (!isPlainObject(id)) {
    if (primary.length > 1) {
      throw new Error(`Composite primary key [${primary.join(', ')}] requires an object with one value per column, got a single value`)
    }
    assertPrimaryKeyValue(id, primary[0])
    return ConditionBuilder.create({ [primary[0]]: id }).build()
  }

  const payload = id

  for (const key of Object.keys(payload)) {
    if (!primary.includes(key)) {
      throw new Error(`Unexpected key "${key}" in primary key payload (primary key: [${primary.join(', ')}])`)
    }
  }

  const filter: Record<string, TPrimaryKeyValue> = {}
  for (const column of primary) {
    const value = payload[column]
    if (value == null) {
      throw new Error(`Missing or null value for primary key column "${column}" (primary key: [${primary.join(', ')}])`)
    }
    assertPrimaryKeyValue(value, column)
    filter[column] = value
  }

  return ConditionBuilder.create(filter).build()
}

// Runtime whitelist matching TPrimaryKeyValue. Ids often arrive as
// deserialized JSON typed `any`; without this check an object value like
// { $ne: 0 } or an array reaches ConditionBuilder as an operator/IN condition
// and widens the filter — the exact injection this module exists to prevent.
function assertPrimaryKeyValue(value: unknown, column: string): asserts value is TPrimaryKeyValue {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    throw new Error(`Primary key value for column "${column}" must be a string, number, or Date`)
  }
}
