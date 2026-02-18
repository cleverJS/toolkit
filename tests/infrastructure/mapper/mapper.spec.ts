import { describe, expect, it } from 'vitest'

import { IMapper } from '../../../src'
import { FieldMapper, IdentityMapper } from '../../../src/infrastructure/mapper'
import { PropertySchema } from '../../../src/utils/types/types'

// Test types
interface UserDomain {
  email: string
  name: string
  age: number
  isActive: boolean
  createdAt: Date
  bio?: string
}

interface UserDBEntity {
  email: string
  name: string
  age: number
  is_active: boolean
  created_at: Date
  bio?: string
}

describe('FieldMapper', () => {
  const mapper = new FieldMapper<UserDomain, UserDBEntity>({
    isActive: 'is_active',
    createdAt: 'created_at',
  })

  describe('toPersistence', () => {
    it('should rename defined fields and skip undefined', () => {
      const result = mapper.toPersistence({ isActive: true, name: 'Alice' })

      expect(result).toEqual({ is_active: true, name: 'Alice' })
    })

    it('should preserve null values', () => {
      const result = mapper.toPersistence({ bio: null } as any)

      expect(result).toEqual({ bio: null })
    })

    it('should pass through fields not in the map unchanged', () => {
      const result = mapper.toPersistence({ email: 'a@b.com', age: 30 })

      expect(result).toEqual({ email: 'a@b.com', age: 30 })
    })

    it('should return empty object for all-undefined input', () => {
      const result = mapper.toPersistence({ email: undefined, isActive: undefined } as any)

      expect(result).toEqual({})
    })
  })

  describe('toDomain', () => {
    it('should reverse-rename DB keys', () => {
      const entity: UserDBEntity = {
        email: 'a@b.com',
        name: 'Alice',
        age: 30,
        is_active: true,
        created_at: new Date('2024-01-01'),
      }

      const domain = mapper.toDomain(entity)

      expect(domain.isActive).toBe(true)
      expect(domain.createdAt).toEqual(new Date('2024-01-01'))
      expect(domain.email).toBe('a@b.com')
      expect(domain.name).toBe('Alice')
      expect(domain.age).toBe(30)
    })

    it('should pass through unmapped keys', () => {
      const entity: UserDBEntity = {
        email: 'a@b.com',
        name: 'Alice',
        age: 30,
        is_active: false,
        created_at: new Date(),
        bio: 'dev',
      }

      const domain = mapper.toDomain(entity)

      expect(domain.bio).toBe('dev')
    })
  })

  describe('getFieldMapping', () => {
    it('should return domain-to-DB field name mapping', () => {
      const mapping = mapper.getFieldMapping()

      expect(mapping).toEqual({ isActive: 'is_active', createdAt: 'created_at' })
    })
  })

  describe('toEntity', () => {
    it('should forward-rename all domain keys', () => {
      const domain: UserDomain = {
        email: 'a@b.com',
        name: 'Alice',
        age: 30,
        isActive: true,
        createdAt: new Date('2024-01-01'),
        bio: 'dev',
      }

      const entity = mapper.toEntity(domain)

      expect(entity.is_active).toBe(true)
      expect(entity.created_at).toEqual(new Date('2024-01-01'))
      expect(entity.email).toBe('a@b.com')
      expect(entity.name).toBe('Alice')
      expect(entity.age).toBe(30)
      expect(entity.bio).toBe('dev')
    })
  })
})

describe('IdentityMapper', () => {
  describe('without fields', () => {
    const mapper = new IdentityMapper<UserDomain>()

    it('getFieldMapping should return undefined', () => {
      expect(mapper.getFieldMapping()).toBeUndefined()
    })

    it('toPersistence should strip undefined and preserve all other values', () => {
      const result = mapper.toPersistence({
        email: 'a@b.com',
        name: undefined,
        isActive: false,
        bio: null,
      } as any)

      expect(result).toEqual({ email: 'a@b.com', isActive: false, bio: null })
      expect('name' in result).toBe(false)
    })

    it('toDomain should shallow-copy the entity (new reference)', () => {
      const entity: UserDomain = {
        email: 'a@b.com',
        name: 'Alice',
        age: 30,
        isActive: true,
        createdAt: new Date(),
      }

      const domain = mapper.toDomain(entity)

      expect(domain).toEqual(entity)
      expect(domain).not.toBe(entity)
    })

    it('toEntity should shallow-copy the data (new reference)', () => {
      const data: UserDomain = {
        email: 'a@b.com',
        name: 'Alice',
        age: 30,
        isActive: true,
        createdAt: new Date(),
      }

      const entity = mapper.toEntity(data)

      expect(entity).toEqual(data)
      expect(entity).not.toBe(data)
    })
  })

  describe('with fields', () => {
    const mapper = new IdentityMapper<UserDomain>(['email', 'name', 'age'])

    it('toDomain should only map listed fields', () => {
      const entity = {
        email: 'a@b.com',
        name: 'Alice',
        age: 30,
        isActive: true,
        createdAt: new Date(),
      } as UserDomain

      const domain = mapper.toDomain(entity)

      expect(domain).toEqual({ email: 'a@b.com', name: 'Alice', age: 30 })
      expect('isActive' in domain).toBe(false)
      expect('createdAt' in domain).toBe(false)
    })

    it('toEntity should only map listed fields', () => {
      const data = {
        email: 'a@b.com',
        name: 'Alice',
        age: 30,
        isActive: true,
        createdAt: new Date(),
      } as UserDomain

      const entity = mapper.toEntity(data)

      expect(entity).toEqual({ email: 'a@b.com', name: 'Alice', age: 30 })
      expect('isActive' in entity).toBe(false)
    })

    it('toPersistence should pick fields and strip undefined', () => {
      const result = mapper.toPersistence({
        email: 'a@b.com',
        name: undefined,
        age: 25,
        isActive: true,
      } as any)

      expect(result).toEqual({ email: 'a@b.com', age: 25 })
      expect('name' in result).toBe(false)
      expect('isActive' in result).toBe(false)
    })
  })
})

describe('Subclass override', () => {
  class CustomMapper extends FieldMapper<UserDomain, UserDBEntity> {
    constructor() {
      super({ isActive: 'is_active', createdAt: 'created_at' })
    }

    override toEntity(data: UserDomain): UserDBEntity {
      return {
        email: data.email || '',
        name: data.name || '',
        age: data.age || 0,
        is_active: data.isActive !== undefined ? data.isActive : true,
        created_at: data.createdAt || new Date('2000-01-01'),
        bio: data.bio,
      }
    }
  }

  const mapper: IMapper<UserDomain, UserDBEntity> = new CustomMapper()

  it('overridden toEntity should apply custom logic', () => {
    const entity = mapper.toEntity({ email: 'a@b.com' } as UserDomain)

    expect(entity.name).toBe('')
    expect(entity.age).toBe(0)
    expect(entity.is_active).toBe(true)
    expect(entity.created_at).toEqual(new Date('2000-01-01'))
  })

  it('toPersistence should still work from base class', () => {
    const result = mapper.toPersistence({ isActive: false, name: 'Bob' } as Partial<PropertySchema<UserDomain>>)

    expect(result).toEqual({ is_active: false, name: 'Bob' })
  })

  it('toDomain should still work from base class', () => {
    const domain = mapper.toDomain({
      email: 'a@b.com',
      name: 'Bob',
      age: 25,
      is_active: false,
      created_at: new Date('2024-06-01'),
    })

    expect(domain.isActive).toBe(false)
    expect(domain.createdAt).toEqual(new Date('2024-06-01'))
  })
})
