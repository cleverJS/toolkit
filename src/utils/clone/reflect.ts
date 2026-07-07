import { CLONEABLE, ICloneable } from './ICloneable'

/**
 * True when the object explicitly opted into custom cloning by carrying the
 * {@link CLONEABLE} brand alongside a `clone()` function. A bare `clone()`
 * method is deliberately NOT enough — see the brand's doc for the rationale.
 */
export function isInstanceOfICloneable(object: unknown): object is ICloneable {
  if (object == null || (typeof object !== 'object' && typeof object !== 'function')) {
    return false
  }
  const candidate = object as { [CLONEABLE]?: unknown; clone?: unknown }
  return candidate[CLONEABLE] === true && typeof candidate.clone === 'function'
}
