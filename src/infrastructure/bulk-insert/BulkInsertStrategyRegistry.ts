import { EntityManager } from '@mikro-orm/core'

import { FallbackBulkInsertStrategy } from './FallbackBulkInsertStrategy'
import { IBulkInsertStrategy } from './IBulkInsertStrategy'
import { PostgresBulkInsertStrategy } from './PostgresBulkInsertStrategy'

/**
 * Registry for managing database-specific bulk insert strategies
 */
export class BulkInsertStrategyRegistry {
  private static instance: BulkInsertStrategyRegistry
  private strategies: IBulkInsertStrategy[] = []
  private readonly fallbackStrategy: IBulkInsertStrategy

  private constructor() {
    // Register database-specific strategies
    this.registerStrategy(new PostgresBulkInsertStrategy())
    // Add more database-specific strategies here:
    // this.registerStrategy(new MSSQLBulkInsertStrategy())
    // this.registerStrategy(new MySQLBulkInsertStrategy())

    // Set fallback strategy
    this.fallbackStrategy = new FallbackBulkInsertStrategy()
  }

  public static getInstance(): BulkInsertStrategyRegistry {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (!BulkInsertStrategyRegistry.instance) {
      BulkInsertStrategyRegistry.instance = new BulkInsertStrategyRegistry()
    }
    return BulkInsertStrategyRegistry.instance
  }

  public registerStrategy(strategy: IBulkInsertStrategy): void {
    this.strategies.push(strategy)
  }

  public getStrategy(em: EntityManager): IBulkInsertStrategy {
    // Find the first strategy that supports the current database
    for (const strategy of this.strategies) {
      if (strategy.isSupported(em)) {
        return strategy
      }
    }

    // Return fallback strategy if no specific strategy is found
    return this.fallbackStrategy
  }

  /**
   * Reset the registry to its default state (useful for testing)
   */
  public reset(): void {
    this.strategies = []
    this.registerStrategy(new PostgresBulkInsertStrategy())
  }
}
