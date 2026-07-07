import { Readable } from 'stream'
import { describe, expect, it, vi } from 'vitest'

import { peekAndReplayStream } from '../../src'

describe('peekAndReplayStream', () => {
  it('should return the first chunk and a replay stream containing all data', async () => {
    const inputData = ['chunk1', 'chunk2', 'chunk3']
    const sourceStream = Readable.from(inputData)

    const { first, replayStream } = await peekAndReplayStream<string>(sourceStream)

    expect(first).toBe('chunk1')

    const resultData: string[] = []
    for await (const chunk of replayStream) {
      resultData.push(chunk as string)
    }

    expect(resultData).toEqual(inputData)
  })

  it('should handle Buffer streams correctly', async () => {
    const inputData = [Buffer.from('hello'), Buffer.from('world')]
    const sourceStream = Readable.from(inputData)

    const { first, replayStream } = await peekAndReplayStream<Buffer>(sourceStream)

    expect(Buffer.isBuffer(first)).toBe(true)
    expect(first.toString()).toBe('hello')

    const resultData: Buffer[] = []
    for await (const chunk of replayStream) {
      resultData.push(chunk as Buffer)
    }

    expect(Buffer.concat(resultData).toString()).toBe('helloworld')
  })

  it('should throw an error if the stream is empty', async () => {
    const sourceStream = Readable.from([])

    await expect(peekAndReplayStream(sourceStream)).rejects.toThrow('Stream is empty')
  })

  it('should clean up resources when replay stream is closed', async () => {
    const sourceStream = Readable.from(['data'])
    const destroySpy = vi.spyOn(sourceStream, 'destroy')

    const { replayStream } = await peekAndReplayStream(sourceStream)

    replayStream.destroy()

    // Give it a moment for the event to propagate
    await new Promise((resolve) => setImmediate(resolve))

    expect(destroySpy).toHaveBeenCalled()
  })

  it('should propagate errors from source stream', async () => {
    const sourceStream = new Readable({
      read() {
        this.emit('error', new Error('Source error'))
      },
    })
    // Add dummy error listener to avoid crashing process

    sourceStream.on('error', () => {})

    await expect(peekAndReplayStream(sourceStream)).rejects.toThrow('Source error')
  })

  // Regression: the replay stream's guard 'error' listener used to be removed
  // before returning. A source error arriving before the caller attached a
  // consumer (e.g. while awaiting schema introspection) was then an unhandled
  // 'error' event — crashing the process. A late consumer must still receive
  // the error via rejected async iteration.
  it('should not crash when the source errors before a consumer attaches, and deliver the error to a late consumer', async () => {
    const sourceStream = new Readable({
      objectMode: true,
      read() {
        this.push('chunk1')
      },
    })
    sourceStream.on('error', () => {})

    const { replayStream } = await peekAndReplayStream<string>(sourceStream)

    // Source errors while no consumer is attached to replayStream.
    sourceStream.destroy(new Error('Error before consumer attached'))
    await new Promise((resolve) => setImmediate(resolve))

    // Late consumer still observes the failure instead of hanging.
    const consume = (async () => {
      const chunks: unknown[] = []
      for await (const chunk of replayStream) {
        chunks.push(chunk)
      }
      return chunks
    })()

    await expect(consume).rejects.toThrow('Error before consumer attached')
  })

  it('should propagate errors occurring after the first chunk', async () => {
    const sourceStream = new Readable({
      read(_size) {
        this.push('chunk1')
        process.nextTick(() => this.emit('error', new Error('Delayed error')))
        this.push(null) // End stream but error is emitted
      },
      objectMode: true,
    })
    // Add dummy error handler to prevent crash before we handle it

    sourceStream.on('error', () => {})

    const { replayStream } = await peekAndReplayStream(sourceStream)

    const promise = new Promise((resolve, reject) => {
      replayStream.on('error', reject)
      replayStream.on('end', resolve)
      replayStream.resume() // Consume stream
    })

    await expect(promise).rejects.toThrow('Delayed error')
  })
})
