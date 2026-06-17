import { TYPES } from 'tedious'
import { describe, expect, it, vi } from 'vitest'

import { MssqlSchemaInspector } from '../../../src/knex'

/**
 * Pure-unit tests for MssqlSchemaInspector — NO database. A minimal fake knex
 * exposes only `.raw(sql, params)`, returning a canned `sys.columns` recordset
 * (the array shape tedious/knex hand back). These tests pin the behaviour that
 * the bug fix established and guard against the three regressions it closed:
 *
 *   - bug #1 (pinned-connection poison): `inspect()` must issue exactly ONE
 *     query. The old code ran knex `columnInfo()` + a flags query under
 *     `Promise.all`; two concurrent requests on a transaction's single pinned
 *     tedious connection throw EINVALIDSTATE. We assert one `raw` call and that
 *     `table(...).columnInfo()` is never touched.
 *   - bug #2 (schema default-to-dbo): the single query is `sys.columns` keyed by
 *     `OBJECT_ID(?)`, which is schema-aware. The mechanism (no `columnInfo()`)
 *     is asserted here; the live non-dbo behaviour is in the integration spec.
 *   - bug #3 (DECIMAL scale loss): `decimal`/`numeric` rows must map precision
 *     and scale into the descriptor options so tedious BulkLoad keeps the
 *     fraction instead of defaulting scale to 0.
 *
 * Live BulkLoad behaviour against a real MSSQL instance lives in
 * MssqlBulkInsertStrategy.spec.ts.
 */

interface ISysColumnRow {
  name: string
  data_type: string
  is_nullable: number | boolean
  is_identity: number | boolean
  is_computed: number | boolean
  max_length: number
  precision: number
  scale: number
}

function row(overrides: Partial<ISysColumnRow> = {}): ISysColumnRow {
  return {
    name: 'col',
    data_type: 'int',
    is_nullable: 1,
    is_identity: 0,
    is_computed: 0,
    max_length: 4,
    precision: 10,
    scale: 0,
    ...overrides,
  }
}

/**
 * A fake knex whose `.raw()` returns a fixed recordset (the plain array tedious
 * returns). `table` is a spy so a test can prove `columnInfo()` is never called
 * — the heart of the bug #1 regression guard.
 */
function createFakeKnex(recordset: ISysColumnRow[]) {
  const columnInfo = vi.fn(async () => {
    throw new Error('columnInfo() must not be called by the inspector')
  })
  const table = vi.fn(() => ({ columnInfo }))
  const raw = vi.fn(async (_sql: string, _params?: unknown[]) => recordset)

  const knex: any = { raw, table }
  return { knex, raw, table, columnInfo }
}

describe('MssqlSchemaInspector (unit)', () => {
  describe('single-query design (guards bug #1 mechanism + bug #2)', () => {
    it('issues exactly one raw() call and never calls table().columnInfo()', async () => {
      const { knex, raw, table, columnInfo } = createFakeKnex([row({ name: 'id' })])
      const inspector = new MssqlSchemaInspector(knex)

      await inspector.inspect('dbo.users')

      expect(raw).toHaveBeenCalledTimes(1)
      expect(table).not.toHaveBeenCalled()
      expect(columnInfo).not.toHaveBeenCalled()
    })

    it('passes the table name as a bound parameter to OBJECT_ID(?)', async () => {
      const { knex, raw } = createFakeKnex([row({ name: 'id' })])
      const inspector = new MssqlSchemaInspector(knex)

      await inspector.inspect('[onboarding].[Requests]')

      const [sql, params] = raw.mock.calls[0]
      // Schema-aware lookup — the table name must travel as a parameter, not be
      // interpolated, and the query must resolve it via OBJECT_ID (not default
      // to dbo the way knex columnInfo() did).
      expect(sql).toMatch(/OBJECT_ID\(\?\)/i)
      expect(sql).toMatch(/sys\.columns/i)
      expect(params).toEqual(['[onboarding].[Requests]'])
    })
  })

  describe('column mapping', () => {
    it('maps precision and scale for a decimal column (guards bug #3)', async () => {
      const { knex } = createFakeKnex([row({ name: 'amount', data_type: 'decimal', is_nullable: 0, max_length: 9, precision: 18, scale: 2 })])
      const inspector = new MssqlSchemaInspector(knex)

      const [descriptor] = await inspector.inspect('dbo.invoices')

      expect(descriptor).toEqual({
        name: 'amount',
        type: TYPES.Decimal,
        options: { nullable: false, precision: 18, scale: 2 },
        isIdentity: false,
        isComputed: false,
      })
    })

    it('maps precision and scale for a numeric column (guards bug #3)', async () => {
      const { knex } = createFakeKnex([row({ name: 'qty', data_type: 'numeric', is_nullable: 1, precision: 10, scale: 4 })])
      const inspector = new MssqlSchemaInspector(knex)

      const [descriptor] = await inspector.inspect('dbo.lines')

      expect(descriptor.type).toBe(TYPES.Numeric)
      expect(descriptor.options.precision).toBe(10)
      expect(descriptor.options.scale).toBe(4)
    })

    it('halves max_length for nvarchar (bytes -> chars)', async () => {
      // sys.columns.max_length is in BYTES; nvarchar stores 2 bytes/char.
      const { knex } = createFakeKnex([row({ name: 'name', data_type: 'nvarchar', max_length: 510 })])
      const inspector = new MssqlSchemaInspector(knex)

      const [descriptor] = await inspector.inspect('dbo.users')

      expect(descriptor.type).toBe(TYPES.NVarChar)
      expect(descriptor.options.length).toBe(255)
    })

    it('maps nvarchar(max) (max_length -1) to Infinity', async () => {
      const { knex } = createFakeKnex([row({ name: 'blob', data_type: 'nvarchar', is_nullable: 1, max_length: -1 })])
      const inspector = new MssqlSchemaInspector(knex)

      const [descriptor] = await inspector.inspect('dbo.docs')

      expect(descriptor.options.length).toBe(Infinity)
    })

    it('keeps max_length as-is for varchar (single-byte chars)', async () => {
      const { knex } = createFakeKnex([row({ name: 'code', data_type: 'varchar', max_length: 50 })])
      const inspector = new MssqlSchemaInspector(knex)

      const [descriptor] = await inspector.inspect('dbo.codes')

      expect(descriptor.type).toBe(TYPES.VarChar)
      expect(descriptor.options.length).toBe(50)
    })

    it('does not set length/precision/scale for a plain int column', async () => {
      const { knex } = createFakeKnex([row({ name: 'age', data_type: 'int', is_nullable: 0 })])
      const inspector = new MssqlSchemaInspector(knex)

      const [descriptor] = await inspector.inspect('dbo.people')

      expect(descriptor.type).toBe(TYPES.Int)
      expect(descriptor.options).toEqual({ nullable: false })
    })

    it('maps is_identity / is_computed / is_nullable flags through (numeric form)', async () => {
      const { knex } = createFakeKnex([
        row({ name: 'id', data_type: 'int', is_nullable: 0, is_identity: 1, is_computed: 0 }),
        row({ name: 'name', data_type: 'nvarchar', is_nullable: 1, is_identity: 0, is_computed: 0, max_length: 510 }),
        row({ name: 'full_name', data_type: 'nvarchar', is_nullable: 1, is_identity: 0, is_computed: 1, max_length: -1 }),
      ])
      const inspector = new MssqlSchemaInspector(knex)

      const byName = new Map((await inspector.inspect('dbo.users')).map((c) => [c.name, c]))

      expect(byName.get('id')).toMatchObject({ isIdentity: true, isComputed: false, options: { nullable: false } })
      expect(byName.get('name')).toMatchObject({ isIdentity: false, isComputed: false, options: { nullable: true } })
      expect(byName.get('full_name')).toMatchObject({ isIdentity: false, isComputed: true, options: { nullable: true } })
    })

    it('coerces SQL Server BIT flags returned as booleans', async () => {
      // Some knex/tedious configs surface bit columns as JS booleans rather
      // than 0/1; the mapping must treat both identically.
      const { knex } = createFakeKnex([row({ name: 'id', data_type: 'int', is_nullable: false, is_identity: true, is_computed: false })])
      const inspector = new MssqlSchemaInspector(knex)

      const [descriptor] = await inspector.inspect('dbo.users')

      expect(descriptor.isIdentity).toBe(true)
      expect(descriptor.isComputed).toBe(false)
      expect(descriptor.options.nullable).toBe(false)
    })

    it('preserves column order from the recordset', async () => {
      const { knex } = createFakeKnex([row({ name: 'a' }), row({ name: 'b' }), row({ name: 'c' })])
      const inspector = new MssqlSchemaInspector(knex)

      const names = (await inspector.inspect('dbo.t')).map((c) => c.name)

      expect(names).toEqual(['a', 'b', 'c'])
    })
  })

  describe('loud-failure contract', () => {
    it('throws when the recordset is empty (OBJECT_ID unresolved)', async () => {
      const { knex } = createFakeKnex([])
      const inspector = new MssqlSchemaInspector(knex)

      // An unresolved OBJECT_ID yields zero rows; the inspector must fail loudly
      // rather than returning an empty schema that would silently drop columns.
      await expect(inspector.inspect('dbo.ghost')).rejects.toThrow(/dbo\.ghost/)
    })

    it('throws on an unsupported column type', async () => {
      const { knex } = createFakeKnex([row({ name: 'geo', data_type: 'geography' })])
      const inspector = new MssqlSchemaInspector(knex)

      await expect(inspector.inspect('dbo.places')).rejects.toThrow(/Unsupported MSSQL column type/)
    })
  })
})
