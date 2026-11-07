#!/usr/bin/env node
/**
 * Standalone PC-side entry for dshm-compat.
 *
 * The same modules run inside DSHM, but a desktop checkout can convert a
 * package and hand the tarball to the device. No dependencies are required.
 */
import { join } from 'node:path'
import { analyze } from '../lib/analyze.js'
import { auditAssets, repairAssetNames } from '../lib/asset-names.js'
import { scan } from '../lib/batch.js'
import { convert } from '../lib/convert.js'
import { buildPlan } from '../lib/plan.js'
import { status } from '../lib/state.js'

const USAGE = `dshm-compat <command> [args]

commands:
  analyze <spec>                 classify one npm/GitHub/local package
  plan <spec>                    print the conversion plan
  convert <spec> [--no-vendor] [--worker <path>]
                                write a converted tarball
  scan <spec> [<spec> ...]       classify several packages
  audit <profileDir> [--fix]     find files the installer named wrong; --fix renames them
  status                         show the local compatibility data directory

spec: npm name[@version], https://github.com/owner/repo, or a local .tgz path
`

const args = process.argv.slice(2)
const command = args[0]
const rest = args.slice(1)

/** @param {string} message */
function fail(message) {
  console.error(message)
  process.exitCode = 1
}

if (command === undefined || command === '--help' || command === '-h') {
  console.log(USAGE)
} else if (command === 'analyze') {
  if (rest[0] === undefined) fail('analyze requires a spec')
  else {
    try {
      const report = await analyze(rest[0], { textScan: true })
      console.log(JSON.stringify(report, null, 2))
    } catch (error) { fail(String(error?.message ?? error)) }
  }
} else if (command === 'plan') {
  if (rest[0] === undefined) fail('plan requires a spec')
  else {
    try {
      const report = await analyze(rest[0], { textScan: true })
      console.log(JSON.stringify(buildPlan(report), null, 2))
    } catch (error) { fail(String(error?.message ?? error)) }
  }
} else if (command === 'convert') {
  if (rest[0] === undefined) fail('convert requires a spec')
  else {
    try {
      const vendor = !rest.includes('--no-vendor')
      const workerAt = rest.indexOf('--worker')
      const workerPath = workerAt >= 0 ? rest[workerAt + 1] : undefined
      const report = await analyze(rest[0], { textScan: false })
      const result = await convert(rest[0], { report, vendor, workerPath })
      console.log(JSON.stringify(result, null, 2))
      if (result.status !== 'ok') process.exitCode = 1
    } catch (error) { fail(String(error?.message ?? error)) }
  }
} else if (command === 'scan') {
  if (rest.length === 0) fail('scan requires at least one spec')
  else {
    try {
      const result = await scan(rest)
      console.log(JSON.stringify({
        counts: result.counts,
        items: result.items.map(({ report: _report, ...item }) => item),
      }, null, 2))
    } catch (error) { fail(String(error?.message ?? error)) }
  }
} else if (command === 'audit') {
  if (rest[0] === undefined) fail('audit requires a profile directory')
  else {
    try {
      const profileDir = rest[0]
      const audit = auditAssets(profileDir)
      if (!rest.includes('--fix') || audit.status === 'missing' || audit.broken.length === 0) {
        console.log(JSON.stringify(audit, null, 2))
      } else {
        const repaired = repairAssetNames(join(profileDir, 'node_modules'))
        console.log(JSON.stringify({
          ...audit,
          repaired: repaired.repaired,
          skipped: repaired.skipped,
          counts: repaired.counts,
          note: 'names only: file contents were not modified, and nothing was deleted',
        }, null, 2))
      }
    } catch (error) { fail(String(error?.message ?? error)) }
  }
} else if (command === 'status') {
  console.log(JSON.stringify(status(), null, 2))
} else {
  fail(`unknown command: ${command}\n\n${USAGE}`)
}
