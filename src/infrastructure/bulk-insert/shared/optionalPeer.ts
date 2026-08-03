/**
 * Resolves an optional peer dependency on first use instead of at module load.
 *
 * Every engine-specific module in this folder tree is reachable through the `/knex` and
 * `/mikro` barrels, so a top-level *value* import silently turns an optional peer into a
 * hard requirement: a Postgres-only service could not even `require('@cleverjs/toolkit/mikro')`
 * without installing the MSSQL driver. Resolving inside the call defers the requirement to
 * the code path that actually needs the driver, and replaces Node's bare `MODULE_NOT_FOUND`
 * (whose require stack points at package internals) with a message naming both the feature
 * and the install command.
 *
 * `load` must contain a literal `require('<name>')` so bundlers still see a static
 * specifier — keep it in sync with `name`.
 *
 * @param name    package specifier, used for the diagnostic only
 * @param feature human-readable feature name, e.g. 'MSSQL bulk insert'
 * @param load    thunk performing the actual `require`
 */
export function loadOptionalPeer<T>(name: string, feature: string, load: () => T): T {
  try {
    return load()
  } catch (err) {
    if (isMissingModule(err, name)) {
      throw new Error(`${feature} requires the optional peer dependency '${name}', which is not installed. Install it: pnpm add ${name}`, {
        cause: err,
      })
    }
    // The package resolved but failed to initialise — that is a different problem and its
    // own error is far more useful than an "install it" hint.
    throw err
  }
}

function isMissingModule(err: unknown, name: string): boolean {
  if (!(err instanceof Error)) return false

  const code = (err as NodeJS.ErrnoException).code
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false

  // A MODULE_NOT_FOUND raised *inside* the peer (because one of its own dependencies is
  // missing) names a different specifier. Only claim "not installed" when the failure is
  // about `name` itself, otherwise the hint sends the caller chasing the wrong package.
  return err.message.includes(`'${name}'`)
}
