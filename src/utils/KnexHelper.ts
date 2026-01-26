import { EntityManager } from '@mikro-orm/core'
import { Knex, SqlEntityManager } from '@mikro-orm/knex'

export class KnexHelper {
  public static getKnex(em: EntityManager): Knex {
    const sem = em as SqlEntityManager

    if (typeof sem.getKnex !== 'function') {
      throw new Error('EntityManager does not support Knex access.')
    }

    const knex = sem.getKnex()

    if (knex == null) {
      throw new Error('Failed to retrieve Knex instance from EntityManager.')
    }

    return knex
  }
}
