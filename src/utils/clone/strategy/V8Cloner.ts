import { deserialize, serialize } from 'v8'

import { ICloner } from './ICloner'

export class V8Cloner implements ICloner {
  public clone<T>(data: T): T {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const cloned: T = deserialize(serialize(data))
    this.restoreTypes(data, cloned)
    return cloned
  }

  private restoreTypes(data: any, cloned: any): void {
    if (data == null || typeof data !== 'object') {
      return
    }

    for (const [key, value] of Object.entries(data)) {
      if (value instanceof Date) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        cloned[key] = new Date(cloned[key])
      } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.restoreTypes(value, cloned[key])
      } else if (Array.isArray(value)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.restoreTypesInArray(value, cloned[key])
      }
    }
  }

  private restoreTypesInArray(data: any[], cloned: any[]): void {
    for (let i = 0; i < data.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const value = data[i]
      if (value instanceof Date) {
        cloned[i] = new Date(cloned[i])
      } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
        this.restoreTypes(value, cloned[i])
      } else if (Array.isArray(value)) {
        this.restoreTypesInArray(value, cloned[i])
      }
    }
  }
}
