import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { runSource, TrainException, formatValue } from '@tom2012/train-core'
import type { Value } from '@tom2012/train-core'
import type { LLMAdapter } from '@tom2012/train-adapter-spec'
import { createMockAdapter, type ScriptEntry } from '@tom2012/train-adapter-mock'
import { parseArgv } from './argv.js'
import {
  formatLexErrors,
  formatParseErrors,
  formatRuntimeError,
} from './format-error.js'

const PKG_VERSION = '0.0.0'
const SCHEMA_VERSION = 'train-1'

export interface CliIO {
  stdout: (s: string) => void
  stderr: (s: string) => void
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string
  /** Environment, defaults to process.env. */
  env?: Record<string, string | undefined>
}

export interface CliResult {
  exitCode: number
}

const HELP_TEXT = `train — domain-specific language for LLM workflows

USAGE:
  train <command> [args] [flags]

COMMANDS:
  run <file> [-- args...]   Execute a .tr file (entry: exported main)
  check <file>              Parse + AST build only, no execution
  version                   Print versions
  help                      Print this message

(planned, not yet implemented:)
  fmt <file>                Format source
  test [pattern]            Run *.test.tr
  repl                      Interactive REPL
  debug <file>              Interactive debugger
  config <op>               Manage config
  adapters                  List adapters
  trace <file>              View trace log

FLAGS for \`run\`:
  --entry <name>            Entry function name (default: main)
  --json                    Emit structured JSON to stdout
  --adapter <id>            Adapter selection: mock | none (default: none)
  --adapter-script <file>   Scripted adapter responses for --adapter=mock
                            (file is a JSON array OR JSONL of ScriptEntry)
  --timeout-ms <ms>         Per-fai-call timeout (default: 600000)
  --no-color                Disable ANSI color in output

(planned, parsed but no-op in M4: --state-dir)

GLOBAL FLAGS:
  --help, -h                Show this help
  --version, -v             Show version
`

function emitVersion(io: CliIO): CliResult {
  io.stdout(
    `train ${PKG_VERSION}\nschema: ${SCHEMA_VERSION}\nnode: ${process.version}\n`,
  )
  return { exitCode: 0 }
}

function emitHelp(io: CliIO): CliResult {
  io.stdout(HELP_TEXT)
  return { exitCode: 0 }
}

function emitUsageError(io: CliIO, msg: string): CliResult {
  io.stderr(`train: ${msg}\n  see 'train --help' for usage\n`)
  return { exitCode: 64 }
}

async function loadScriptEntries(filePath: string): Promise<ScriptEntry[]> {
  const text = await fs.readFile(filePath, 'utf8')
  const raw: unknown[] = text.trim().startsWith('[')
    ? (JSON.parse(text) as unknown[])
    : text
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as unknown)
  return raw as ScriptEntry[]
}

async function resolveAdapter(
  flags: Map<string, string | boolean>,
): Promise<LLMAdapter | undefined> {
  const id = flags.get('--adapter')
  if (!id || id === 'none' || id === true) return undefined
  if (id === 'mock') {
    const scriptPath = flags.get('--adapter-script')
    const script =
      typeof scriptPath === 'string' ? await loadScriptEntries(scriptPath) : []
    return createMockAdapter(script)
  }
  throw new Error(`unknown --adapter: ${String(id)} (supported: mock, none)`)
}

async function resolveFile(io: CliIO, file: string): Promise<string> {
  const cwd = io.cwd ?? process.cwd()
  const abs = path.isAbsolute(file) ? file : path.join(cwd, file)
  return fs.readFile(abs, 'utf8')
}

function renderValue(v: Value | null): string {
  if (v === null) return 'null'
  return formatValue(v)
}

async function cmdRun(args: ReturnType<typeof parseArgv>, io: CliIO): Promise<CliResult> {
  const file = args.positional[0]
  if (!file) return emitUsageError(io, '`train run` requires a file argument')

  let source: string
  try {
    source = await resolveFile(io, file)
  } catch (e) {
    io.stderr(`train: cannot read ${file}: ${(e as Error).message}\n`)
    return { exitCode: 64 }
  }

  const json = args.flags.get('--json') === true
  const entry =
    typeof args.flags.get('--entry') === 'string'
      ? (args.flags.get('--entry') as string)
      : 'main'

  const timeoutRaw = args.flags.get('--timeout-ms')
  const defaultFaiTimeoutMs =
    typeof timeoutRaw === 'string' ? Number(timeoutRaw) : undefined

  let adapter: LLMAdapter | undefined
  try {
    adapter = await resolveAdapter(args.flags)
  } catch (e) {
    return emitUsageError(io, (e as Error).message)
  }

  const result = await runSource(source, {
    entry,
    args: args.programArgs as Value[],
    adapter,
    defaultFaiTimeoutMs,
  })

  if (result.lexErrors.length > 0) {
    const f = formatLexErrors(result.lexErrors, file, source)
    if (json) {
      io.stdout(
        JSON.stringify({
          ok: false,
          phase: 'lex',
          errors: result.lexErrors,
        }) + '\n',
      )
    } else {
      io.stderr(f.text + '\n')
    }
    return { exitCode: f.exitCode }
  }
  if (result.parseErrors.length > 0) {
    const f = formatParseErrors(result.parseErrors, file, source)
    if (json) {
      io.stdout(
        JSON.stringify({
          ok: false,
          phase: 'parse',
          errors: result.parseErrors.map((e: any) => ({
            message: e.message,
            line: e.token?.startLine,
            column: e.token?.startColumn,
          })),
        }) + '\n',
      )
    } else {
      io.stderr(f.text + '\n')
    }
    return { exitCode: f.exitCode }
  }

  if (!result.ok) {
    const exc = result.error
    if (exc instanceof TrainException) {
      const f = formatRuntimeError(exc, file, source)
      if (json) {
        io.stdout(
          JSON.stringify({
            ok: false,
            phase: 'runtime',
            errorType: exc.errorType,
            message: exc.message,
            range: exc.range ?? null,
          }) + '\n',
        )
      } else {
        io.stderr(f.text + '\n')
      }
      return { exitCode: f.exitCode }
    }
    io.stderr(`train: unknown runtime failure (no exception object)\n`)
    return { exitCode: 2 }
  }

  if (json) {
    io.stdout(
      JSON.stringify({ ok: true, value: result.value }) + '\n',
    )
  } else {
    io.stdout(renderValue(result.value) + '\n')
  }
  return { exitCode: 0 }
}

async function cmdCheck(args: ReturnType<typeof parseArgv>, io: CliIO): Promise<CliResult> {
  const file = args.positional[0]
  if (!file) return emitUsageError(io, '`train check` requires a file argument')

  let source: string
  try {
    source = await resolveFile(io, file)
  } catch (e) {
    io.stderr(`train: cannot read ${file}: ${(e as Error).message}\n`)
    return { exitCode: 64 }
  }

  // We don't execute; just parse + build AST and report any errors.
  const { parseToAst } = await import('@tom2012/train-core')
  const r = parseToAst(source)
  if (r.lexErrors.length > 0) {
    const f = formatLexErrors(r.lexErrors, file, source)
    io.stderr(f.text + '\n')
    return { exitCode: f.exitCode }
  }
  if (r.parseErrors.length > 0) {
    const f = formatParseErrors(r.parseErrors, file, source)
    io.stderr(f.text + '\n')
    return { exitCode: f.exitCode }
  }
  io.stdout(`${file}: ok\n`)
  return { exitCode: 0 }
}

export async function runCli(
  argv: string[],
  ioRaw: Partial<CliIO> = {},
): Promise<CliResult> {
  const io: CliIO = {
    stdout: ioRaw.stdout ?? ((s) => process.stdout.write(s)),
    stderr: ioRaw.stderr ?? ((s) => process.stderr.write(s)),
    cwd: ioRaw.cwd,
    env: ioRaw.env,
  }

  const args = parseArgv(argv)

  if (args.versionRequested) return emitVersion(io)
  if (args.helpRequested && args.command === null) return emitHelp(io)

  switch (args.command) {
    case null:
      return emitHelp(io)
    case 'help':
      return emitHelp(io)
    case 'version':
      return emitVersion(io)
    case 'run':
      return cmdRun(args, io)
    case 'check':
      return cmdCheck(args, io)
    case 'fmt':
    case 'test':
    case 'repl':
    case 'debug':
    case 'config':
    case 'adapters':
    case 'trace':
      io.stderr(
        `train: not-implemented: '${args.command}' is planned for a later milestone\n`,
      )
      return { exitCode: 75 }
    default:
      return emitUsageError(io, `unknown command: '${args.command}'`)
  }
}
