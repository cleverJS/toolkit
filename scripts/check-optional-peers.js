#!/usr/bin/env node
'use strict'

/**
 * Verifies the "install only what you need" contract of the published entry points.
 *
 * Optional peer dependencies must not be require()d at module-load time by an entry that
 * does not genuinely need them — otherwise a consumer of, say, `/mikro` who only talks to
 * Postgres cannot even import the package without installing the MSSQL driver. Barrel
 * re-exports make this trivially easy to reintroduce: one top-level value import anywhere
 * in the graph and every consumer of that entry pays for it.
 *
 * The check loads each built entry with one peer's resolution forced to fail, and compares
 * the outcome against MATRIX below. Run after `pnpm build`.
 */

const Module = require('module')
const path = require('path')
const fs = require('fs')

const DIST = path.resolve(__dirname, '..', 'dist')

const OPTIONAL_PEERS = ['@mikro-orm/core', 'knex', 'kysely', 'pg', 'pg-copy-streams', 'tedious']

/**
 * Peers each entry is allowed to hard-require at load time. Everything else must stay
 * deferred to the code path that uses it. Adding a name here is a deliberate decision to
 * make that peer mandatory for that entry — document it in the README's peer table too.
 */
const MATRIX = {
  'index.js': [],
  'objects.js': [],
  // KnexRepository is generic over the `Knex` type only; the driver is supplied by the caller.
  'knex.js': [],
  // MikroRepository is built on MikroORM's EntityManager and its Kysely query builder —
  // neither is substitutable, so both are load-time requirements of this entry.
  'mikro.js': ['@mikro-orm/core', 'kysely'],
}

function loadWithPeerBlocked(entry, blockedPeer) {
  const original = Module._resolveFilename

  Module._resolveFilename = function (request, ...rest) {
    if (request === blockedPeer || request.startsWith(blockedPeer + '/')) {
      const err = new Error(`Cannot find module '${request}'`)
      err.code = 'MODULE_NOT_FOUND'
      throw err
    }
    return original.call(this, request, ...rest)
  }

  try {
    for (const key of Object.keys(require.cache)) delete require.cache[key]
    require(path.join(DIST, entry))
    return null
  } catch (err) {
    return err
  } finally {
    Module._resolveFilename = original
    for (const key of Object.keys(require.cache)) delete require.cache[key]
  }
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error('✖ dist/ not found — run `pnpm build` first.')
    process.exit(1)
  }

  const violations = []

  for (const entry of Object.keys(MATRIX)) {
    const allowed = MATRIX[entry]

    for (const peer of OPTIONAL_PEERS) {
      const err = loadWithPeerBlocked(entry, peer)
      const isAllowed = allowed.includes(peer)

      if (err && !isAllowed) {
        violations.push(`${entry} requires optional peer '${peer}' at load time — ${err.message.split('\n')[0]}`)
      } else if (!err && isAllowed) {
        violations.push(`${entry} no longer requires '${peer}' at load time — remove it from MATRIX and relax the documented requirement.`)
      }

      const status = err ? 'requires' : 'optional'
      const mark = (err && !isAllowed) || (!err && isAllowed) ? '✖' : '✓'
      console.log(`  ${mark} ${entry.padEnd(11)} ${peer.padEnd(17)} ${status}`)
    }
  }

  if (violations.length > 0) {
    console.error('\n✖ Optional peer dependency contract violated:\n')
    for (const v of violations) console.error(`  - ${v}`)
    console.error('\nDefer the import to first use — see `loadOptionalPeer` in src/infrastructure/bulk-insert/shared/optionalPeer.ts\n')
    process.exit(1)
  }

  console.log('\n✓ Optional peer dependency contract holds for all entry points.')
}

main()
