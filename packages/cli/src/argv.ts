export interface ParsedArgs {
  command: string | null
  positional: string[]
  flags: Map<string, string | boolean>
  /** Args after `--` separator. Passed to the train program's entry function. */
  programArgs: string[]
  /** Bare --help / -h / --version / -v anywhere in argv. */
  helpRequested: boolean
  versionRequested: boolean
}

const BOOLEAN_FLAGS = new Set([
  '--json',
  '--no-color',
  '--help',
  '--version',
  '-h',
  '-v',
])

export function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: null,
    positional: [],
    flags: new Map(),
    programArgs: [],
    helpRequested: false,
    versionRequested: false,
  }

  let i = 0
  let seenDoubleDash = false

  while (i < argv.length) {
    const arg = argv[i]!

    if (seenDoubleDash) {
      out.programArgs.push(arg)
      i++
      continue
    }

    if (arg === '--') {
      seenDoubleDash = true
      i++
      continue
    }

    if (arg === '--help' || arg === '-h') {
      out.helpRequested = true
      i++
      continue
    }

    if (arg === '--version' || arg === '-v') {
      out.versionRequested = true
      i++
      continue
    }

    if (arg.startsWith('--')) {
      if (BOOLEAN_FLAGS.has(arg)) {
        out.flags.set(arg, true)
        i++
        continue
      }
      const eq = arg.indexOf('=')
      if (eq >= 0) {
        out.flags.set(arg.slice(0, eq), arg.slice(eq + 1))
        i++
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        out.flags.set(arg, next)
        i += 2
        continue
      }
      out.flags.set(arg, true)
      i++
      continue
    }

    if (out.command === null) {
      out.command = arg
    } else {
      out.positional.push(arg)
    }
    i++
  }

  return out
}
