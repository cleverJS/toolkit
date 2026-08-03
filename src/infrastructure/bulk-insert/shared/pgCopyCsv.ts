import type { from as pgCopyFrom } from 'pg-copy-streams'
import { Transform } from 'stream'

import { loadOptionalPeer } from './optionalPeer'

/**
 * Shared CSV serialization for the PostgreSQL `COPY ... FROM STDIN` strategies.
 * `PostgresBulkInsertStrategy` (knex) and `PostgresCopyBulkInsertStrategy`
 * (Mikro/Kysely) must produce byte-identical COPY payloads — this module is
 * the single place that defines the format, so escaping fixes apply to both.
 */

let cachedCopyFrom: typeof pgCopyFrom | undefined

/**
 * Resolves `pg-copy-streams`' `from()` on first use.
 *
 * Both COPY strategies are re-exported by the `/knex` and `/mikro` barrels, so a
 * top-level value import would make this optional peer mandatory for every consumer
 * of those entries — including MSSQL-only ones that never run a COPY. See
 * `loadOptionalPeer`.
 */
export function copyFrom(): typeof pgCopyFrom {
  cachedCopyFrom ??= loadOptionalPeer<{ from: typeof pgCopyFrom }>(
    'pg-copy-streams',
    'PostgreSQL COPY bulk insert',
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return
    () => require('pg-copy-streams')
  ).from

  return cachedCopyFrom
}

/** Escapes a single SQL identifier by quoting and doubling embedded double-quotes. */
export function escapePgIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Escapes a possibly schema-qualified name (`schema.table`) into
 * `"schema"."table"`. A bare `table` becomes `"table"`. The dot is treated as
 * the schema separator to match how Kysely and knex parse the same string —
 * `escapePgIdentifier('public.users')` alone would yield `"public.users"`, one
 * identifier literally named `public.users`, so COPY would target the wrong
 * (default-schema) relation.
 */
export function escapePgQualifiedName(name: string): string {
  return name
    .split('.')
    .map((part) => escapePgIdentifier(part.trim()))
    .join('.')
}

/** Builds the `COPY <table> (<columns>) FROM STDIN` statement for the mapping's DB columns. */
export function buildCopyFromStdinSql(table: string, objectToDBmapping: Record<string, string>): string {
  const columns = Object.values(objectToDBmapping).map(escapePgIdentifier).join(', ')
  return `COPY ${escapePgQualifiedName(table)} (${columns}) FROM STDIN WITH (FORMAT csv, DELIMITER E'\\t')`
}

/**
 * Creates a Transform that serializes entity rows (keyed by property name)
 * into tab-delimited CSV lines ordered by the mapping's columns. Missing keys
 * and null/undefined become NULL (empty unquoted field); empty strings are
 * quoted so they stay empty strings. `onRow` fires once per serialized row —
 * COPY reports no row count, so callers count here.
 */
export function createTabRowTransform(objectToDBmapping: Record<string, string>, onRow?: () => void): Transform {
  const objectKeys = Object.keys(objectToDBmapping)

  return new Transform({
    objectMode: true,
    transform(chunk: Record<string, unknown>, _enc, callback) {
      try {
        const orderedValues = objectKeys.map((key) => {
          let value: unknown = null
          if (Object.prototype.hasOwnProperty.call(chunk, key)) {
            // eslint-disable-next-line security/detect-object-injection
            value = chunk[key]
          }
          return serializeCsvValue(value)
        })

        onRow?.()
        callback(null, orderedValues.join('\t') + '\n')
      } catch (e) {
        callback(e as Error)
      }
    },
  })
}

function serializeCsvValue(value: unknown): string {
  if (value === undefined || value === null) return ''

  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString()
  }

  if (typeof value === 'object') {
    const string = JSON.stringify(value)
    return `"${string.replace(/"/g, '""')}"`
  }

  // At this point value is a primitive (string | number | boolean | bigint | symbol).
  let strValue: string
  if (typeof value === 'string') {
    strValue = value
  } else {
    // number | boolean | bigint | symbol — each has a well-defined toString().
    strValue = (value as number | boolean | bigint | symbol).toString()
  }

  // COPY CSV treats an unquoted empty field as NULL — quote it so an empty
  // string stays an empty string instead of becoming NULL.
  if (strValue === '') {
    return '""'
  }

  if (strValue.includes('\t') || strValue.includes('\n') || strValue.includes('"') || strValue.includes('\r')) {
    return `"${strValue.replace(/"/g, '""')}"`
  }
  return strValue
}
