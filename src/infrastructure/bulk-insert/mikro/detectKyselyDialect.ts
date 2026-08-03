import type { Kysely } from 'kysely'

export type KyselyDialect = 'postgres' | 'mssql' | 'mysql' | 'sqlite' | 'unknown'

/**
 * Detects the underlying SQL dialect of a Kysely instance.
 *
 * Reads the public `getExecutor().adapter` (a `DialectAdapter`) and inspects the
 * concrete class name. Names follow Kysely's convention — `PostgresAdapter`,
 * `MssqlAdapter`, `MysqlAdapter`, `SqliteAdapter` — and have been stable across
 * 0.27.x → 0.29.x. Returns `'unknown'` for unfamiliar adapters; callers should
 * fall back to a dialect-agnostic strategy.
 *
 * This is the only place we rely on the adapter class name; if Kysely renames
 * it, isolate the breakage here.
 */
export function detectKyselyDialect(kysely: Kysely<any>): KyselyDialect {
  try {
    const adapter = kysely.getExecutor().adapter as { constructor: { name: string } } | undefined
    const name = adapter?.constructor?.name ?? ''

    if (name.includes('Postgres')) return 'postgres'
    if (name.includes('Mssql')) return 'mssql'
    if (name.includes('Mysql')) return 'mysql'
    if (name.includes('Sqlite')) return 'sqlite'
  } catch {
    // Detection is best-effort. Fall through to 'unknown'.
  }
  return 'unknown'
}
