/**
 * Explicit opt-in brand for {@link ICloneable}. Registered via `Symbol.for` so
 * detection works even when two copies of the toolkit end up in node_modules.
 *
 * Detection used to be duck-typed on a `clone()` method anywhere in the
 * prototype chain, which false-positived on third-party objects that happen to
 * expose `clone()` with different semantics (knex QueryBuilder, moment, ...)
 * and silently hijacked their cloning. The brand makes the contract explicit.
 */
export const CLONEABLE: unique symbol = Symbol.for('@cleverjs/toolkit:cloneable')

/**
 * Custom clone behavior for `Cloner.clone()`. Implementations must carry the
 * {@link CLONEABLE} brand:
 *
 * ```ts
 * class MyEntity implements ICloneable {
 *   readonly [CLONEABLE] = true
 *   clone(): this { ... }
 * }
 * ```
 */
export interface ICloneable {
  readonly [CLONEABLE]: true
  clone(nextData?: any): this
}
