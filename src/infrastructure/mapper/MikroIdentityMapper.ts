import { removeUndefined } from '../../utils/helpers/object'
import { PropertySchema } from '../../utils/types/types'
import { IMapper } from '../IRepository'

export class MikroIdentityMapper<Domain, DBEntity extends object> implements IMapper<Domain, DBEntity> {
  public constructor(private readonly EntityClass: new () => DBEntity) {}

  public toDomain(entity: DBEntity): Domain {
    return { ...entity } as unknown as Domain
  }

  public toEntity(data: Domain): DBEntity {
    const entity = new this.EntityClass()
    Object.assign(entity, data)
    return entity
  }

  public getFieldMapping(): Record<string, string> | undefined {
    return undefined
  }

  public toPersistence(domain: Partial<PropertySchema<Domain>>): Partial<DBEntity> {
    return removeUndefined(domain as Record<string, any>) as Partial<DBEntity>
  }
}
