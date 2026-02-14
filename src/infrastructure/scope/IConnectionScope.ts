export type IsolationLevel = 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'

export interface TransactionOptions {
  isolationLevel?: IsolationLevel
}

export interface IConnectionScope<TConnection = unknown> {
  /** Returns the current connection (base or active transaction) */
  getConnection(): TConnection

  /** Returns true if currently executing inside a transaction */
  isInTransaction(): boolean

  /** Execute fn in a transaction. Nested calls create savepoints. */
  transaction<T>(fn: () => Promise<T>, options?: TransactionOptions): Promise<T>
}
