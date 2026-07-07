import { AdapterType, ConditionAdapterRegistry, ConditionBuilder, KnexConditionAdapter } from '@cleverjs/condition-builder'
import { Knex } from 'knex'
import { describe, expect, it } from 'vitest'

import { IdentityMapper } from '../../src'
import { KnexConnectionScope, KnexRepository } from '../../src/knex'

interface Row {
  id?: number
  txt: string
  createdAt?: string
}

interface ICall {
  method: string
  args: unknown[]
}

/**
 * Chainable, thenable query-builder stub: every method call is recorded and
 * returns the same proxy; awaiting it resolves with the queued result. Lets
 * unit tests script exact DB responses (e.g. "SELECT finds the row, UPDATE
 * returns nothing" or MySQL's "[insertId]") that are impossible to time or
 * produce deterministically against a real database.
 */
function createChainable(result: unknown, calls: ICall[]): unknown {
  const target = (): void => {}
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(result).then(resolve, reject)
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args })
        return proxy
      }
    },
  })
  return proxy
}

/** Fake Knex: each `knex(table)` call consumes the next scripted result. */
function createFakeKnex(results: unknown[], dialect = 'pg'): { knex: Knex; calls: ICall[] } {
  const calls: ICall[] = []
  const fn = (_table: string): unknown => createChainable(results.shift() ?? [], calls)
  fn.client = { config: { client: dialect } }
  return { knex: fn as unknown as Knex, calls }
}

function createRepository(fakeKnex: Knex, primary: string[] = ['id']): KnexRepository<Row, Row> {
  const registry = new ConditionAdapterRegistry()
  registry.register(AdapterType.KNEX, new KnexConditionAdapter())

  return new KnexRepository<Row, Row>(new KnexConnectionScope(fakeKnex), new IdentityMapper<Row>(), {
    table: 'fake_table',
    primary,
    conditionRegistry: registry,
  })
}

function whereArgs(calls: ICall[]): unknown[][] {
  return calls.filter((c) => c.method === 'where').map((c) => c.args)
}

describe('KnexRepository (unit, scripted DB responses)', () => {
  describe('updateOne', () => {
    // Regression: the row existed at SELECT time but was deleted before the
    // UPDATE ran. The mapper used to receive `undefined` and silently return
    // {} as the "updated" domain entity.
    it('should throw (not return an empty object) when the row is deleted between SELECT and UPDATE', async () => {
      const { knex } = createFakeKnex([
        [{ id: 1, txt: 'old' }], // SELECT: row is found
        [], // UPDATE ... RETURNING: row already gone
        [], // re-fetch by primary key: still gone
      ])
      const repository = createRepository(knex)
      const condition = ConditionBuilder.create({ id: 1 }).build()

      await expect(repository.updateOne(condition, { txt: 'new' })).rejects.toThrow('Entity to update was deleted concurrently')
    })

    it('should still throw "not found" when the SELECT finds nothing', async () => {
      const { knex } = createFakeKnex([[]])
      const repository = createRepository(knex)
      const condition = ConditionBuilder.create({ id: 1 }).build()

      await expect(repository.updateOne(condition, { txt: 'new' })).rejects.toThrow('Entity to update not found')
    })

    it('should return the mapped entity when the UPDATE returns the row', async () => {
      const { knex } = createFakeKnex([
        [{ id: 1, txt: 'old' }], // SELECT
        [{ id: 1, txt: 'new' }], // UPDATE ... RETURNING
      ])
      const repository = createRepository(knex)
      const condition = ConditionBuilder.create({ id: 1 }).build()

      const updated = await repository.updateOne(condition, { txt: 'new' })
      expect(updated).toEqual({ id: 1, txt: 'new' })
    })

    // MySQL: update() resolves with the affected-row count, not rows.
    it('should re-fetch by primary key when the dialect returns a count (MySQL)', async () => {
      const { knex } = createFakeKnex(
        [
          [{ id: 1, txt: 'old' }], // SELECT
          1, // UPDATE: affected-row count
          [{ id: 1, txt: 'new' }], // re-fetch by primary key
        ],
        'mysql2'
      )
      const repository = createRepository(knex)
      const condition = ConditionBuilder.create({ id: 1 }).build()

      const updated = await repository.updateOne(condition, { txt: 'new' })
      expect(updated).toEqual({ id: 1, txt: 'new' })
    })

    // MySQL reports 0 affected rows for a no-op update of identical values —
    // that must not be mistaken for "row deleted".
    it('should not treat MySQL count 0 (no-op update) as a concurrent delete', async () => {
      const { knex } = createFakeKnex(
        [
          [{ id: 1, txt: 'same' }], // SELECT
          0, // UPDATE: nothing changed (identical values)
          [{ id: 1, txt: 'same' }], // re-fetch: row is alive
        ],
        'mysql2'
      )
      const repository = createRepository(knex)
      const condition = ConditionBuilder.create({ id: 1 }).build()

      const updated = await repository.updateOne(condition, { txt: 'same' })
      expect(updated).toEqual({ id: 1, txt: 'same' })
    })
  })

  describe('findById', () => {
    it('should throw when the repository has no primary key configured', async () => {
      const { knex } = createFakeKnex([])
      const repository = createRepository(knex, [])

      await expect(repository.findById(1)).rejects.toThrow('Repository has no primary key configured')
    })

    it('should query by the configured primary key column', async () => {
      const { knex } = createFakeKnex([[{ id: 5, txt: 'found' }]])
      const repository = createRepository(knex)

      const found = await repository.findById(5)

      expect(found).toEqual({ id: 5, txt: 'found' })
    })
  })

  describe('insert', () => {
    it('should re-fetch by insertId on MySQL when the payload has no primary key value', async () => {
      const { knex, calls } = createFakeKnex(
        [
          [7], // INSERT: knex resolves with [insertId] on MySQL
          [{ id: 7, txt: 'a', createdAt: '2026-07-07' }], // re-fetch by id
        ],
        'mysql2'
      )
      const repository = createRepository(knex)

      const inserted = await repository.insert({ txt: 'a' })

      // Full row incl. the DB-generated default proves it came from the re-fetch.
      expect(inserted).toEqual({ id: 7, txt: 'a', createdAt: '2026-07-07' })
      expect(whereArgs(calls)).toEqual([[{ id: 7 }]])
    })

    it('should prefer primary key values from the payload over insertId', async () => {
      const { knex, calls } = createFakeKnex(
        [
          [0], // INSERT: insertId 0 — table has no auto-increment column
          [{ id: 42, txt: 'a' }], // re-fetch by payload PK
        ],
        'mysql2'
      )
      const repository = createRepository(knex)

      const inserted = await repository.insert({ id: 42, txt: 'a' })

      expect(inserted).toEqual({ id: 42, txt: 'a' })
      // The lookup must use the payload's id, never the bogus insertId 0.
      expect(whereArgs(calls)).toEqual([[{ id: 42 }]])
    })

    // The returned number is only trusted as insertId on the MySQL family —
    // on any other dialect a bare number is ambiguous and must be refused.
    it('should NOT trust a numeric result as insertId on a non-MySQL dialect', async () => {
      const { knex, calls } = createFakeKnex(
        [
          [5], // some driver returned a bare number on a pg-flavored dialect
        ],
        'pg'
      )
      const repository = createRepository(knex)

      await expect(repository.insert({ txt: 'a' })).rejects.toThrow(/cannot be identified/)
      // No speculative re-fetch by the untrusted number.
      expect(whereArgs(calls)).toEqual([])
    })

    it('should throw a clear error when the row cannot be identified at all', async () => {
      const { knex } = createFakeKnex(
        [
          [0], // insertId 0 and no primary config below
        ],
        'mysql2'
      )
      const repository = createRepository(knex, []) // no primary key configured

      await expect(repository.insert({ txt: 'a' })).rejects.toThrow(/Configure `primary`|cannot be identified/)
    })

    it('should throw when the re-fetch finds no row', async () => {
      const { knex } = createFakeKnex(
        [
          [7], // INSERT ok
          [], // re-fetch: row vanished
        ],
        'mysql2'
      )
      const repository = createRepository(knex)

      await expect(repository.insert({ txt: 'a' })).rejects.toThrow(/not found on re-fetch/)
    })
  })
})
