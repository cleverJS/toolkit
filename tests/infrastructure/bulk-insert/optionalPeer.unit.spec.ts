import { describe, expect, it, vi } from 'vitest'

import { loadOptionalPeer } from '../../../src/infrastructure/bulk-insert/shared/optionalPeer'

function moduleNotFound(specifier: string): Error {
  const err: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`)
  err.code = 'MODULE_NOT_FOUND'
  return err
}

describe('loadOptionalPeer', () => {
  it('returns whatever the loader resolves', () => {
    const peer = { TYPES: { Bit: 'bit' } }

    expect(loadOptionalPeer('tedious', 'MSSQL bulk insert', () => peer)).toBe(peer)
  })

  it('does not invoke the loader until called', () => {
    const load = vi.fn(() => 'loaded')

    expect(load).not.toHaveBeenCalled()
    expect(loadOptionalPeer('tedious', 'MSSQL bulk insert', load)).toBe('loaded')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reports a missing peer with the feature name and an install hint', () => {
    const original = moduleNotFound('tedious')

    try {
      loadOptionalPeer('tedious', 'MSSQL bulk insert', () => {
        throw original
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe(
        "MSSQL bulk insert requires the optional peer dependency 'tedious', which is not installed. Install it: pnpm add tedious"
      )
      // The raw resolution failure stays reachable for anyone debugging the require stack.
      expect((err as Error).cause).toBe(original)
    }
  })

  it('handles ESM-style resolution failures too', () => {
    const err: NodeJS.ErrnoException = new Error("Cannot find package 'pg-copy-streams' imported from /app/index.mjs")
    err.code = 'ERR_MODULE_NOT_FOUND'

    expect(() =>
      loadOptionalPeer('pg-copy-streams', 'PostgreSQL COPY bulk insert', () => {
        throw err
      })
    ).toThrow(/requires the optional peer dependency 'pg-copy-streams'/)
  })

  it('rethrows a MODULE_NOT_FOUND about a different module untouched', () => {
    // tedious itself is installed but one of ITS dependencies is missing — telling the
    // caller to install tedious would send them chasing the wrong package.
    const original = moduleNotFound('@azure/identity')

    expect(() =>
      loadOptionalPeer('tedious', 'MSSQL bulk insert', () => {
        throw original
      })
    ).toThrow(original)
  })

  it('rethrows a non-resolution failure untouched', () => {
    // The package resolved but blew up while initialising: its own error is the useful one.
    const original = new TypeError('boom during module init')

    expect(() =>
      loadOptionalPeer('tedious', 'MSSQL bulk insert', () => {
        throw original
      })
    ).toThrow(original)
  })
})
