import { ICloner } from './ICloner'

export class JSONCloner implements ICloner {
  public clone<T>(data: T): T {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const cloned: T = JSON.parse(JSON.stringify(data))
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
      } else if (value instanceof Buffer) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        cloned[key] = Buffer.from(cloned[key])
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
      } else if (value instanceof Buffer) {
        cloned[i] = Buffer.from(cloned[i])
      } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
        this.restoreTypes(value, cloned[i])
      } else if (Array.isArray(value)) {
        this.restoreTypesInArray(value, cloned[i])
      }
    }
  }
}
