import { removeUndefined } from '../../utils/helpers/object'
import { PropertySchema } from '../../utils/types/types'
import { IMapper } from '../IRepository'

export class IdentityMapper<Entity> implements IMapper<Entity, Entity> {
  private readonly fields?: string[]

  public constructor(fields?: (keyof PropertySchema<Entity> & string)[]) {
    this.fields = fields
  }

  public toDomain(entity: Entity): Entity {
    if (this.fields) {
      return this.pick(entity) as Entity
    }

    return { ...entity }
  }

  public toEntity(data: Entity): Entity {
    if (this.fields) {
      return this.pick(data) as Entity
    }

    return { ...data }
  }

  public toPersistence(domain: Partial<PropertySchema<Entity>>): Partial<Entity> {
    if (this.fields) {
      const picked = this.pick(domain as Entity)
      return removeUndefined(picked as Record<string, any>) as Partial<Entity>
    }

    return removeUndefined(domain as Record<string, any>) as Partial<Entity>
  }

  public getFieldMapping(): Record<string, string> | undefined {
    return undefined
  }

  private pick(source: Entity): Partial<Entity> {
    const result: Record<string, unknown> = {}

    for (const key of this.fields!) {
      if (key in (source as Record<string, unknown>)) {
        result[key] = (source as Record<string, unknown>)[key]
      }
    }

    return result as Partial<Entity>
  }
}
