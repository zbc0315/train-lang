import { describe, test, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli, type CliIO } from '../src/main.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')
const HELLO_TR = path.join(__dirname, '..', '..', '..', 'examples', 'hello.tr')

function makeIO(): { io: Partial<CliIO>; out: () => string; err: () => string } {
  let outBuf = ''
  let errBuf = ''
  return {
    io: {
      stdout: (s) => {
        outBuf += s
      },
      stderr: (s) => {
        errBuf += s
      },
    },
    out: () => outBuf,
    err: () => errBuf,
  }
}

describe('train CLI', () => {
  test('--version prints package + schema versions', async () => {
    const { io, out } = makeIO()
    const r = await runCli(['--version'], io)
    expect(r.exitCode).toBe(0)
    expect(out()).toMatch(/train \d/)
    expect(out()).toMatch(/schema: train-1/)
  })

  test('--help lists all commands', async () => {
    const { io, out } = makeIO()
    const r = await runCli(['--help'], io)
    expect(r.exitCode).toBe(0)
    expect(out()).toContain('run <file>')
    expect(out()).toContain('check <file>')
  })

  test('no args prints help (exit 0)', async () => {
    const { io, out } = makeIO()
    const r = await runCli([], io)
    expect(r.exitCode).toBe(0)
    expect(out()).toContain('USAGE')
  })

  test('unknown command exits 64', async () => {
    const { io, err } = makeIO()
    const r = await runCli(['bogus-cmd'], io)
    expect(r.exitCode).toBe(64)
    expect(err()).toContain('unknown command')
  })

  test('planned-but-unimplemented command exits 75 (NotImplemented)', async () => {
    const { io, err } = makeIO()
    const r = await runCli(['fmt', 'foo.tr'], io)
    expect(r.exitCode).toBe(75)
    expect(err()).toMatch(/not-implemented/)
  })

  test('run pure.tr returns 5 (2+3)', async () => {
    const { io, out } = makeIO()
    const r = await runCli(['run', path.join(FIXTURES, 'pure.tr')], io)
    expect(r.exitCode).toBe(0)
    expect(out().trim()).toBe('5')
  })

  test('run pure.tr --json emits structured result', async () => {
    const { io, out } = makeIO()
    const r = await runCli(
      ['run', path.join(FIXTURES, 'pure.tr'), '--json'],
      io,
    )
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(out().trim())
    expect(parsed).toEqual({ ok: true, value: 5 })
  })

  test('run with missing file exits 64', async () => {
    const { io, err } = makeIO()
    const r = await runCli(['run', '/no/such/file.tr'], io)
    expect(r.exitCode).toBe(64)
    expect(err()).toContain('cannot read')
  })

  test('run syntax-err.tr exits 1 with parse error frame', async () => {
    const { io, err } = makeIO()
    const r = await runCli(
      ['run', path.join(FIXTURES, 'syntax-err.tr')],
      io,
    )
    expect(r.exitCode).toBe(1)
    expect(err()).toContain('syntax-err.tr')
    expect(err()).toContain('^')
  })

  test('check pure.tr reports ok', async () => {
    const { io, out } = makeIO()
    const r = await runCli(['check', path.join(FIXTURES, 'pure.tr')], io)
    expect(r.exitCode).toBe(0)
    expect(out()).toContain('ok')
  })

  test('check syntax-err.tr exits 1', async () => {
    const { io, err } = makeIO()
    const r = await runCli(
      ['check', path.join(FIXTURES, 'syntax-err.tr')],
      io,
    )
    expect(r.exitCode).toBe(1)
    expect(err()).toMatch(/error/)
  })

  test('run hello.tr without adapter exits 2 (RuntimeError on fai call)', async () => {
    const { io, err } = makeIO()
    const r = await runCli(['run', HELLO_TR, '--', 'World'], io)
    expect(r.exitCode).toBe(2)
    expect(err()).toMatch(/adapter/i)
  })

  test('run hello.tr with --adapter=mock + script succeeds', async () => {
    const { io, out } = makeIO()
    const r = await runCli(
      [
        'run',
        HELLO_TR,
        '--adapter',
        'mock',
        '--adapter-script',
        path.join(FIXTURES, 'hello-mock.script.json'),
        '--',
        'World',
      ],
      io,
    )
    expect(r.exitCode).toBe(0)
    expect(out().trim()).toBe('Hello, mock world!')
  })

  test('run hello.tr --json --adapter=mock emits success JSON', async () => {
    const { io, out } = makeIO()
    const r = await runCli(
      [
        'run',
        HELLO_TR,
        '--json',
        '--adapter',
        'mock',
        '--adapter-script',
        path.join(FIXTURES, 'hello-mock.script.json'),
        '--',
        'World',
      ],
      io,
    )
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(out().trim())
    expect(parsed.ok).toBe(true)
    expect(parsed.value).toBe('Hello, mock world!')
  })

  test('run runtime-err.tr without adapter exits 2', async () => {
    const { io, err } = makeIO()
    const r = await runCli(
      ['run', path.join(FIXTURES, 'runtime-err.tr')],
      io,
    )
    expect(r.exitCode).toBe(2)
    expect(err()).toContain('RuntimeError')
  })
})
