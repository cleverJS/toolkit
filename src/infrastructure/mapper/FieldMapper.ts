import { PropertySchema } from '../../utils/types/types'
import { IMapper } from '../IRepository'

export type FieldMapping<Domain, DBEntity> = Partial<{
  [K in keyof PropertySchema<Domain> & string]: keyof DBEntity & string
}>

export class FieldMapper<Domain, DBEntity> implements IMapper<Domain, DBEntity> {
  private readonly domainToDB: Map<string, string>
  private readonly dbToDomain: Map<string, string>

  public constructor(fieldMap: FieldMapping<Domain, DBEntity>) {
    this.domainToDB = new Map()
    this.dbToDomain = new Map()

    for (const [domainKey, dbKey] of Object.entries(fieldMap)) {
      this.domainToDB.set(domainKey, dbKey as string)
      this.dbToDomain.set(dbKey as string, domainKey)
    }
  }

  public toDomain(entity: DBEntity): Domain {
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(entity as Record<string, unknown>)) {
      const domainKey = this.dbToDomain.get(key) ?? key
      result[domainKey] = value
    }

    return result as Domain
  }

  public toEntity(data: Domain): DBEntity {
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const dbKey = this.domainToDB.get(key) ?? key
      result[dbKey] = value
    }

    return result as DBEntity
  }

  public getFieldMapping(): Record<string, string> | undefined {
    return Object.fromEntries(this.domainToDB)
  }

  public toPersistence(domain: Partial<PropertySchema<Domain>>): Partial<DBEntity> {
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(domain as Record<string, unknown>)) {
      if (value === undefined) continue
      const dbKey = this.domainToDB.get(key) ?? key
      result[dbKey] = value
    }

    return result as Partial<DBEntity>
  }
}
