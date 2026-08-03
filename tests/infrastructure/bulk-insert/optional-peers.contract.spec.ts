import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../..')
const SCRIPT = resolve(ROOT, 'scripts/check-optional-peers.js')
const DIST = resolve(ROOT, 'dist')

/**
 * The load-time peer contract can only be observed on the built CJS output — that is what a
 * consumer actually requires, and barrel re-exports are what break it. `pnpm build` does not
 * run before `pnpm tests`, so this asserts against dist/ when it happens to be there and
 * skips otherwise; CI runs `pnpm check:peers` right after the build as the gating check.
 */
describe('published entry points do not hard-require optional peers', () => {
  const hasDist = existsSync(DIST)

  it.skipIf(!hasDist)('holds for every entry × optional peer combination', () => {
    // process.execPath, not 'node' — an absolute path avoids resolving through PATH.
    expect(() => execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })).not.toThrow()
  })

  it.runIf(!hasDist)('is skipped without a build — run `pnpm build && pnpm check:peers`', () => {
    expect(hasDist).toBe(false)
  })
})
