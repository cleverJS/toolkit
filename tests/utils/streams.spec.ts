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
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    sourceStream.on('error', () => {})

    await expect(peekAndReplayStream(sourceStream)).rejects.toThrow('Source error')
  })

  it('should propagate errors occurring after the first chunk', async () => {
    const sourceStream = new Readable({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      read(_size) {
        this.push('chunk1')
        process.nextTick(() => this.emit('error', new Error('Delayed error')))
        this.push(null) // End stream but error is emitted
      },
      objectMode: true,
    })
    // Add dummy error handler to prevent crash before we handle it
    // eslint-disable-next-line @typescript-eslint/no-empty-function
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
