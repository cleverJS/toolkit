import { TClass } from '../types/types'

export function isInstanceOf<T>(obj: unknown, condition: string | ((o: any) => boolean)): obj is T {
  if (typeof condition === 'string') {
    return typeof obj === 'object' && obj !== null && condition in obj
  }
  return condition(obj)
}

export const isInstanceOfByCondition = <T>(object: unknown, condition: (object: any) => boolean): object is T => {
  return isInstanceOf<T>(object, condition)
}

export function isExactInstanceOf<T extends object>(e: unknown, cls: TClass<T>): e is T {
  return isInstanceOf<T>(e, (o) => {
    return o instanceof cls && o.constructor === cls
  })
}
