import { PassThrough, Readable } from 'stream'

/**
 * Peeks at the first chunk of a readable stream and returns it along with a replay stream
 * that contains all data (including the first chunk).
 *
 * @template T - The type of the first chunk
 * @param originalStream - The source readable stream (must support async iteration)
 * @returns An object containing the first chunk and a PassThrough stream with all data
 * @throws Error if the stream doesn't support async iteration or is empty
 *
 * @example
 * ```typescript
 * const { first, replayStream } = await peekAndReplayStream<Buffer>(sourceStream)
 * console.log('First chunk:', first)
 * replayStream.pipe(destination)
 * ```
 */
export async function peekAndReplayStream<T>(originalStream: Readable): Promise<{ first: T; replayStream: PassThrough }> {
  const outputStream = new PassThrough({ objectMode: true })

  // Temporary error handler to prevent unhandled error crashes during setup
  const noop = () => {
    // Intentionally empty - used to suppress unhandled error during setup
  }
  outputStream.on('error', noop)

  const cleanup = (err?: Error) => {
    if (!originalStream.destroyed) {
      originalStream.destroy(err)
    }
    if (!outputStream.destroyed) {
      outputStream.destroy(err)
    }
  }

  // Forward errors from original stream to output stream
  originalStream.on('error', (err) => {
    cleanup(err)
  })

  // Clean up originalStream when outputStream is destroyed
  outputStream.on('close', () => {
    if (!originalStream.destroyed) {
      originalStream.destroy()
    }
  })

  let asyncIter: AsyncIterator<T>
  try {
    asyncIter = (originalStream[Symbol.asyncIterator] as () => AsyncIterator<T>)()
  } catch (err) {
    cleanup(err as Error)
    throw new Error('Stream does not support async iteration')
  }

  try {
    const result = await asyncIter.next()
    const firstChunk = result.value as T
    const done = result.done

    if (done) {
      outputStream.end()
      throw new Error('Stream is empty')
    }

    if (!outputStream.write(firstChunk)) {
      await new Promise<void>((resolve) => outputStream.once('drain', resolve))
    }

    async function pumpRest() {
      const iterable = {
        [Symbol.asyncIterator]() {
          return asyncIter
        },
      }

      for await (const chunk of iterable) {
        if (outputStream.destroyed) {
          return
        }
        if (!outputStream.write(chunk)) {
          await new Promise<void>((resolve) => outputStream.once('drain', resolve))
        }
      }
      if (!outputStream.destroyed) {
        outputStream.end()
      }
    }

    pumpRest().catch((err: Error) => {
      if (!outputStream.destroyed) {
        outputStream.destroy(err)
      }
    })

    outputStream.removeListener('error', noop)
    return { first: firstChunk, replayStream: outputStream }
  } catch (err) {
    cleanup(err as Error)
    throw err
  }
}
