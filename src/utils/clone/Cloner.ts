import { Stream } from 'node:stream'

import { isInstanceOfICloneable } from './reflect'
import { ICloner } from './strategy/ICloner'
import { StructuredCloner } from './strategy/StructuredCloner'

export class Cloner {
  private static instance: Cloner
  private cloner: ICloner

  private constructor() {
    this.cloner = new StructuredCloner()
  }

  public static getInstance(): Cloner {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (!Cloner.instance) {
      Cloner.instance = new Cloner()
    }

    return Cloner.instance
  }

  public static isCloneable(obj: unknown): boolean {
    if (obj == null || typeof obj !== 'object') {
      return typeof obj !== 'function'
    }

    if (obj instanceof Stream) {
      return false
    }

    if (obj instanceof WeakMap || obj instanceof WeakSet) {
      return false
    }

    return true
  }

  public setCloner(cloner: ICloner) {
    this.cloner = cloner
  }

  public clone<T>(data: T): T {
    let result: T
    const instanceOfICloneable = isInstanceOfICloneable(data)
    if (instanceOfICloneable) {
      result = data.clone(data)
    } else {
      if (!Cloner.isCloneable(data)) {
        throw new Error('Object cannot be cloned because it contains non-serializable values (e.g., streams, functions)')
      }

      result = this.cloner.clone<T>(data)
    }

    return result
  }
}
