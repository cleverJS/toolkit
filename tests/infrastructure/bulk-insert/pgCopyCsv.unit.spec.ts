import { describe, expect, it } from 'vitest'

import { buildCopyFromStdinSql, escapePgIdentifier, escapePgQualifiedName } from '../../../src/infrastructure/bulk-insert/shared/pgCopyCsv'

describe('pgCopyCsv identifier escaping', () => {
  describe('escapePgIdentifier', () => {
    it('quotes a single identifier and doubles embedded quotes', () => {
      expect(escapePgIdentifier('users')).toBe('"users"')
      expect(escapePgIdentifier('we"ird')).toBe('"we""ird"')
    })

    it('does NOT split on dots (a column name is a single identifier)', () => {
      expect(escapePgIdentifier('a.b')).toBe('"a.b"')
    })
  })

  describe('escapePgQualifiedName', () => {
    it('quotes each part of a schema-qualified name separately', () => {
      expect(escapePgQualifiedName('public.users')).toBe('"public"."users"')
    })

    it('quotes a bare table name', () => {
      expect(escapePgQualifiedName('users')).toBe('"users"')
    })

    it('trims whitespace around the separator', () => {
      expect(escapePgQualifiedName('public . users')).toBe('"public"."users"')
    })

    it('doubles embedded quotes in each part', () => {
      expect(escapePgQualifiedName('sch"ema.ta"ble')).toBe('"sch""ema"."ta""ble"')
    })
  })

  describe('buildCopyFromStdinSql', () => {
    // Regression: a schema-qualified table used to be escaped as one identifier
    // ("public.users"), so COPY targeted a relation literally named
    // "public.users" in the search_path instead of table users in schema public.
    it('renders a schema-qualified table as separate quoted identifiers', () => {
      const sql = buildCopyFromStdinSql('public.users', { id: 'id', name: 'name' })
      expect(sql).toBe('COPY "public"."users" ("id", "name") FROM STDIN WITH (FORMAT csv, DELIMITER E\'\\t\')')
    })

    it('renders a bare table name unqualified', () => {
      const sql = buildCopyFromStdinSql('users', { id: 'id' })
      expect(sql).toBe('COPY "users" ("id") FROM STDIN WITH (FORMAT csv, DELIMITER E\'\\t\')')
    })
  })
})
