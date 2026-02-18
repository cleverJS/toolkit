import { describe, expect, it } from 'vitest'

import { FallbackBulkInsertStrategy, PostgresBulkInsertStrategy, resolveBulkInsertStrategy } from '../../../src'

function createFakeKnex(dialect: string): any {
  return { client: { config: { client: dialect } } }
}

describe('resolveBulkInsertStrategy', () => {
  it('should return PostgresBulkInsertStrategy for "pg" dialect', () => {
    const strategy = resolveBulkInsertStrategy(createFakeKnex('pg'))
    expect(strategy).toBeInstanceOf(PostgresBulkInsertStrategy)
  })

  it('should return PostgresBulkInsertStrategy for "postgresql" dialect', () => {
    const strategy = resolveBulkInsertStrategy(createFakeKnex('postgresql'))
    expect(strategy).toBeInstanceOf(PostgresBulkInsertStrategy)
  })

  it('should return FallbackBulkInsertStrategy for unknown dialect', () => {
    const strategy = resolveBulkInsertStrategy(createFakeKnex('mysql'))
    expect(strategy).toBeInstanceOf(FallbackBulkInsertStrategy)
  })

  it('should return FallbackBulkInsertStrategy when dialect is missing', () => {
    const strategy = resolveBulkInsertStrategy({ client: {} } as any)
    expect(strategy).toBeInstanceOf(FallbackBulkInsertStrategy)
  })
})
