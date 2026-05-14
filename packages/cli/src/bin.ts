#!/usr/bin/env node
import { runCli } from './main.js'

let sigintArmed = false
function handleSigint() {
  if (sigintArmed) return // 2nd Ctrl+C → let process die naturally
  sigintArmed = true
  process.stderr.write('\ntrain: cancelled\n')
  process.exit(130)
}
process.on('SIGINT', handleSigint)
process.on('SIGTERM', handleSigint)

const argv = process.argv.slice(2)
runCli(argv).then(
  (r) => {
    process.exit(r.exitCode)
  },
  (e) => {
    process.stderr.write(`train: internal error: ${(e as Error).stack ?? e}\n`)
    process.exit(70)
  },
)
