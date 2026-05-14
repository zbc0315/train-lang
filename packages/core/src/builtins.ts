/**
 * Built-in functions / values available to every train program.
 *
 * Per spec §2.9 (deliberately conservative — no I/O / network / shell).
 * Side-effectful operations live behind `fai` (LLM-driven) and are
 * provided by adapters, not core.
 *
 * `log` is a namespace value (object) holding info / warn / error
 * builtins; user code calls `log.info("…")` which the interpreter
 * resolves as MemberExpr on the `log` binding.
 */

import {
  type Value,
  type BuiltinFunction,
  makeBuiltin,
  TrainException,
  isFunctionValue,
  isBuiltin,
} from './runtime.js'

// ─── Helpers ──────────────────────────────────────────────────────────

function ensureArity(name: string, args: Value[], min: number, max?: number) {
  const upper = max ?? min
  if (args.length < min || args.length > upper) {
    throw new TrainException(
      'RuntimeError',
      `${name}() expects ${min === upper ? min : `${min}-${upper}`} arg(s), got ${args.length}`,
    )
  }
}

function typeName(v: Value): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (isFunctionValue(v) || isBuiltin(v)) return 'function'
  return typeof v
}

function expectNumber(name: string, v: Value, idx: number): number {
  if (typeof v !== 'number')
    throw new TrainException(
      'RuntimeError',
      `${name}(): arg ${idx} expected number, got ${typeName(v)}`,
    )
  return v
}

function expectString(name: string, v: Value, idx: number): string {
  if (typeof v !== 'string')
    throw new TrainException(
      'RuntimeError',
      `${name}(): arg ${idx} expected string, got ${typeName(v)}`,
    )
  return v
}

function expectArray(name: string, v: Value, idx: number): Value[] {
  if (!Array.isArray(v))
    throw new TrainException(
      'RuntimeError',
      `${name}(): arg ${idx} expected array, got ${typeName(v)}`,
    )
  return v
}

function expectObject(
  name: string,
  v: Value,
  idx: number,
): { [k: string]: Value } {
  if (
    v === null ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    isFunctionValue(v) ||
    isBuiltin(v as unknown as Value)
  ) {
    throw new TrainException(
      'RuntimeError',
      `${name}(): arg ${idx} expected object, got ${typeName(v)}`,
    )
  }
  return v as { [k: string]: Value }
}

// ─── Format helper for print/log ──────────────────────────────────────

function formatValue(v: Value): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v))
    return '[' + v.map((x) => formatValueAsJson(x)).join(', ') + ']'
  if (isFunctionValue(v)) return `<function ${v.name}>`
  if (isBuiltin(v as unknown as Value))
    return `<builtin ${(v as unknown as BuiltinFunction).name}>`
  // plain object
  const entries = Object.entries(v).map(
    ([k, val]) => `${k}: ${formatValueAsJson(val)}`,
  )
  return '{ ' + entries.join(', ') + ' }'
}

function formatValueAsJson(v: Value): string {
  // Inside container: strings get quoted.
  if (typeof v === 'string') return JSON.stringify(v)
  return formatValue(v)
}

// ─── Builtins ─────────────────────────────────────────────────────────

const builtinSpecs: Array<[string, (args: Value[]) => Value]> = [
  // ─── I/O (best-effort: writes to host console) ───────────────────────
  [
    'print',
    (args) => {
      const text = args.map(formatValue).join(' ')
      // eslint-disable-next-line no-console
      console.log(text)
      return null
    },
  ],

  // ─── Collection ──────────────────────────────────────────────────────
  [
    'len',
    (args) => {
      ensureArity('len', args, 1)
      const v = args[0]!
      if (typeof v === 'string') return [...v].length // codepoint count
      if (Array.isArray(v)) return v.length
      if (
        v !== null &&
        typeof v === 'object' &&
        !isFunctionValue(v) &&
        !isBuiltin(v as unknown as Value)
      ) {
        return Object.keys(v as { [k: string]: Value }).length
      }
      throw new TrainException(
        'RuntimeError',
        `len(): expected string/array/object, got ${typeName(v)}`,
      )
    },
  ],
  [
    'push',
    (args) => {
      ensureArity('push', args, 2)
      const arr = expectArray('push', args[0]!, 0)
      arr.push(args[1]!)
      return null
    },
  ],
  [
    'pop',
    (args) => {
      ensureArity('pop', args, 1)
      const arr = expectArray('pop', args[0]!, 0)
      return arr.length > 0 ? arr.pop()! : null
    },
  ],
  [
    'contains',
    (args) => {
      ensureArity('contains', args, 2)
      const target = args[1]!
      if (Array.isArray(args[0])) {
        return args[0].some((x) => deepEq(x, target))
      }
      if (typeof args[0] === 'string') {
        return typeof target === 'string' && args[0].includes(target)
      }
      throw new TrainException(
        'RuntimeError',
        `contains(): expected array or string, got ${typeName(args[0]!)}`,
      )
    },
  ],
  [
    'keys',
    (args) => {
      ensureArity('keys', args, 1)
      const o = expectObject('keys', args[0]!, 0)
      return Object.keys(o)
    },
  ],
  [
    'values',
    (args) => {
      ensureArity('values', args, 1)
      const o = expectObject('values', args[0]!, 0)
      return Object.values(o)
    },
  ],
  [
    'range',
    (args) => {
      // range(n) / range(start, end) / range(start, end, step)
      let start = 0
      let end: number
      let step = 1
      if (args.length === 1) {
        end = expectNumber('range', args[0]!, 0)
      } else if (args.length === 2) {
        start = expectNumber('range', args[0]!, 0)
        end = expectNumber('range', args[1]!, 1)
      } else if (args.length === 3) {
        start = expectNumber('range', args[0]!, 0)
        end = expectNumber('range', args[1]!, 1)
        step = expectNumber('range', args[2]!, 2)
        if (step === 0)
          throw new TrainException('RuntimeError', 'range(): step must not be 0')
      } else {
        throw new TrainException(
          'RuntimeError',
          `range() expects 1-3 args, got ${args.length}`,
        )
      }
      const out: number[] = []
      if (step > 0) for (let i = start; i < end; i += step) out.push(i)
      else for (let i = start; i > end; i += step) out.push(i)
      return out
    },
  ],

  // ─── String ──────────────────────────────────────────────────────────
  [
    'concat',
    (args) => {
      return args.map(formatValue).join('')
    },
  ],
  [
    'split',
    (args) => {
      ensureArity('split', args, 2)
      const s = expectString('split', args[0]!, 0)
      const sep = expectString('split', args[1]!, 1)
      return s.split(sep)
    },
  ],
  [
    'upper',
    (args) => {
      ensureArity('upper', args, 1)
      return expectString('upper', args[0]!, 0).toUpperCase()
    },
  ],
  [
    'lower',
    (args) => {
      ensureArity('lower', args, 1)
      return expectString('lower', args[0]!, 0).toLowerCase()
    },
  ],
  [
    'trim',
    (args) => {
      ensureArity('trim', args, 1)
      return expectString('trim', args[0]!, 0).trim()
    },
  ],
  [
    'matches',
    (args) => {
      ensureArity('matches', args, 2)
      const s = expectString('matches', args[0]!, 0)
      const pattern = expectString('matches', args[1]!, 1)
      try {
        return new RegExp(pattern).test(s)
      } catch (e) {
        throw new TrainException(
          'RuntimeError',
          `matches(): invalid regex ${pattern}: ${(e as Error).message}`,
        )
      }
    },
  ],
  [
    'replace',
    (args) => {
      ensureArity('replace', args, 3)
      const s = expectString('replace', args[0]!, 0)
      const pat = expectString('replace', args[1]!, 1)
      const rep = expectString('replace', args[2]!, 2)
      try {
        return s.replace(new RegExp(pat, 'g'), rep)
      } catch {
        // fall back to plain string replace if not a valid regex
        return s.split(pat).join(rep)
      }
    },
  ],

  // ─── Numeric ─────────────────────────────────────────────────────────
  [
    'abs',
    (args) => {
      ensureArity('abs', args, 1)
      return Math.abs(expectNumber('abs', args[0]!, 0))
    },
  ],
  [
    'min',
    (args) => {
      if (args.length === 0)
        throw new TrainException('RuntimeError', 'min(): expects at least 1 arg')
      let m = expectNumber('min', args[0]!, 0)
      for (let i = 1; i < args.length; i++) {
        const v = expectNumber('min', args[i]!, i)
        if (v < m) m = v
      }
      return m
    },
  ],
  [
    'max',
    (args) => {
      if (args.length === 0)
        throw new TrainException('RuntimeError', 'max(): expects at least 1 arg')
      let m = expectNumber('max', args[0]!, 0)
      for (let i = 1; i < args.length; i++) {
        const v = expectNumber('max', args[i]!, i)
        if (v > m) m = v
      }
      return m
    },
  ],
  [
    'sum',
    (args) => {
      ensureArity('sum', args, 1)
      const arr = expectArray('sum', args[0]!, 0)
      let acc = 0
      for (let i = 0; i < arr.length; i++) {
        acc += expectNumber('sum', arr[i]!, i)
      }
      return acc
    },
  ],
  [
    'floor',
    (args) => {
      ensureArity('floor', args, 1)
      return Math.floor(expectNumber('floor', args[0]!, 0))
    },
  ],
  [
    'ceil',
    (args) => {
      ensureArity('ceil', args, 1)
      return Math.ceil(expectNumber('ceil', args[0]!, 0))
    },
  ],
  [
    'round',
    (args) => {
      ensureArity('round', args, 1)
      return Math.round(expectNumber('round', args[0]!, 0))
    },
  ],

  // ─── Conversions ─────────────────────────────────────────────────────
  [
    'int',
    (args) => {
      ensureArity('int', args, 1)
      const v = args[0]!
      if (typeof v === 'number') return Math.trunc(v)
      if (typeof v === 'string') {
        const n = Number.parseInt(v, 10)
        if (Number.isNaN(n))
          throw new TrainException(
            'RuntimeError',
            `int(): cannot parse string "${v}"`,
          )
        return n
      }
      if (typeof v === 'boolean') return v ? 1 : 0
      throw new TrainException(
        'RuntimeError',
        `int(): cannot convert ${typeName(v)}`,
      )
    },
  ],
  [
    'float',
    (args) => {
      ensureArity('float', args, 1)
      const v = args[0]!
      if (typeof v === 'number') return v
      if (typeof v === 'string') {
        const n = Number.parseFloat(v)
        if (Number.isNaN(n))
          throw new TrainException(
            'RuntimeError',
            `float(): cannot parse string "${v}"`,
          )
        return n
      }
      if (typeof v === 'boolean') return v ? 1.0 : 0.0
      throw new TrainException(
        'RuntimeError',
        `float(): cannot convert ${typeName(v)}`,
      )
    },
  ],
  [
    'string',
    (args) => {
      ensureArity('string', args, 1)
      return formatValue(args[0]!)
    },
  ],
  [
    'bool',
    (args) => {
      ensureArity('bool', args, 1)
      const v = args[0]!
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') return v.length > 0
      if (v === null) return false
      if (Array.isArray(v)) return v.length > 0
      return true
    },
  ],

  // ─── Utility ─────────────────────────────────────────────────────────
  [
    'now',
    (args) => {
      ensureArity('now', args, 0)
      return new Date().toISOString()
    },
  ],
  [
    'uuid',
    (args) => {
      ensureArity('uuid', args, 0)
      // Lightweight v4 generator (not cryptographically strong but
      // adequate for run IDs / non-secret tags).
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        const v = c === 'x' ? r : (r & 0x3) | 0x8
        return v.toString(16)
      })
    },
  ],
  [
    'hash',
    (args) => {
      ensureArity('hash', args, 1)
      const s = expectString('hash', args[0]!, 0)
      // FNV-1a 64-bit hex (sufficient for cache keys etc; not crypto)
      let h = 0xcbf29ce484222325n
      const prime = 0x100000001b3n
      for (let i = 0; i < s.length; i++) {
        h ^= BigInt(s.charCodeAt(i))
        h = BigInt.asUintN(64, h * prime)
      }
      return h.toString(16).padStart(16, '0')
    },
  ],
]

// ─── log namespace ────────────────────────────────────────────────────

const logNamespace: { [k: string]: Value } = {
  info: makeBuiltin('log.info', (args) => {
    // eslint-disable-next-line no-console
    console.log('[info]', args.map(formatValue).join(' '))
    return null
  }) as unknown as Value,
  warn: makeBuiltin('log.warn', (args) => {
    // eslint-disable-next-line no-console
    console.warn('[warn]', args.map(formatValue).join(' '))
    return null
  }) as unknown as Value,
  error: makeBuiltin('log.error', (args) => {
    // eslint-disable-next-line no-console
    console.error('[error]', args.map(formatValue).join(' '))
    return null
  }) as unknown as Value,
}

// ─── Public registry ──────────────────────────────────────────────────

export function defaultBuiltinBindings(): Map<string, Value> {
  const m = new Map<string, Value>()
  for (const [name, fn] of builtinSpecs) {
    m.set(name, makeBuiltin(name, fn) as unknown as Value)
  }
  m.set('log', logNamespace)
  return m
}

// ─── Deep equality (used by `contains`) ───────────────────────────────

function deepEq(a: Value, b: Value): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEq(a[i]!, b[i]!)) return false
    return true
  }
  if (typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) || Array.isArray(b)) return false
    const ao = a as { [k: string]: Value }
    const bo = b as { [k: string]: Value }
    const ak = Object.keys(ao)
    const bk = Object.keys(bo)
    if (ak.length !== bk.length) return false
    for (const k of ak) {
      if (!(k in bo)) return false
      if (!deepEq(ao[k]!, bo[k]!)) return false
    }
    return true
  }
  return false
}

export { deepEq, formatValue }
