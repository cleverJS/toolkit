import { PassThrough } from 'stream'

export interface IBulkInsertStrategy<TConnection = unknown> {
  execute<T>(connection: TConnection, stream: PassThrough & AsyncIterable<T>, options: IBulkInsertOptions): Promise<number>
}

export interface IBulkInsertOptions {
  table: string
  objectToDBmapping: Record<string, string>
}
