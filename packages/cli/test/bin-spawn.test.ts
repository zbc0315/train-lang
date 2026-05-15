import { describe, test, expect, beforeAll } from 'vitest'
import { execa } from 'execa'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(__dirname, '..', 'dist', 'bin.js')
const FIXTURES = path.join(__dirname, 'fixtures')

describe('train bin.js (spawn)', () => {
  beforeAll(() => {
    if (!existsSync(BIN)) {
      throw new Error(
        `bin not built. Run \`pnpm --filter @tom2012/train-cli build\` first. Expected: ${BIN}`,
      )
    }
  })

  test('--version via spawn', async () => {
    const { exitCode, stdout } = await execa('node', [BIN, '--version'])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/schema: train-1/)
  })

  test('--help via spawn', async () => {
    const { exitCode, stdout } = await execa('node', [BIN, '--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('USAGE')
  })

  test('unknown command via spawn exits 64', async () => {
    const r = await execa('node', [BIN, 'bogus-cmd'], { reject: false })
    expect(r.exitCode).toBe(64)
    expect(r.stderr).toContain('unknown command')
  })

  test('not-implemented command via spawn exits 75', async () => {
    const r = await execa('node', [BIN, 'fmt', 'foo.tr'], { reject: false })
    expect(r.exitCode).toBe(75)
    expect(r.stderr).toContain('not-implemented')
  })

  test('run pure.tr via spawn exits 0', async () => {
    const { exitCode, stdout } = await execa('node', [
      BIN,
      'run',
      path.join(FIXTURES, 'pure.tr'),
    ])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('5')
  })

  test('run syntax-err.tr via spawn exits 1', async () => {
    const r = await execa(
      'node',
      [BIN, 'run', path.join(FIXTURES, 'syntax-err.tr')],
      { reject: false },
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('^')
  })
})
