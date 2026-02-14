import { ICloner } from './ICloner'

export class StructuredCloner implements ICloner {
  public clone<T>(data: T): T {
    return structuredClone(data)
  }
}
