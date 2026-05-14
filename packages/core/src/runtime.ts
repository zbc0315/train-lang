/**
 * Runtime value model + execution state for the train interpreter.
 *
 * For this milestone the interpreter executes everything in process
 * memory; persistent stack-frame serialization (needed for fai
 * suspend/resume) will be added in M3 when LLM adapters arrive.
 */

import type * as ast from './ast.js'

/** Runtime values. Mirrors train's surface types. */
export type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | { [key: string]: Value }
  | FunctionValue

/**
 * Functions (both `func` and `fai`) are first-class only internally —
 * they are stored in the runtime context as named bindings, NOT in
 * user variables. Source code cannot create them as expression values.
 */
export interface FunctionValue {
  readonly __kind: 'function'
  readonly name: string
  readonly isFai: boolean
  readonly decl: ast.FuncDecl | ast.FaiDecl
  /** The lexical scope where the function was defined. */
  readonly definedIn: Scope
}

export function isFunctionValue(v: Value): v is FunctionValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (v as any).__kind === 'function'
  )
}

/** A lexical scope: chain of binding maps. */
export interface Scope {
  parent: Scope | null
  bindings: Map<string, Value>
}

export function newScope(parent: Scope | null = null): Scope {
  return { parent, bindings: new Map() }
}

export function scopeLookup(scope: Scope, name: string): Value | undefined {
  let s: Scope | null = scope
  while (s) {
    if (s.bindings.has(name)) return s.bindings.get(name)!
    s = s.parent
  }
  return undefined
}

/**
 * Assign to an existing binding in the closest scope where it's
 * defined. Returns false if no such binding exists (caller decides
 * whether to error or create one).
 */
export function scopeAssign(scope: Scope, name: string, value: Value): boolean {
  let s: Scope | null = scope
  while (s) {
    if (s.bindings.has(name)) {
      s.bindings.set(name, value)
      return true
    }
    s = s.parent
  }
  return false
}

/** Runtime context for a whole program execution. */
export interface RuntimeContext {
  /** Top-level constants (immutable at runtime). */
  constants: Map<string, Value>
  /** Top-level `var` globals (mutable). */
  globals: Map<string, Value>
  /** Named function declarations (func + fai). */
  functions: Map<string, FunctionValue>
  /** Builtins registered before execution. */
  builtins: Map<string, BuiltinFunction>
  /** Names that are publicly exported from this program. */
  exports: Map<string, string> // exported-name → internal binding name
}

export interface BuiltinFunction {
  readonly __kind: 'builtin'
  readonly name: string
  call(args: Value[]): Value
}

export function makeBuiltin(
  name: string,
  call: (args: Value[]) => Value,
): BuiltinFunction {
  return { __kind: 'builtin', name, call }
}

export function isBuiltin(v: unknown): v is BuiltinFunction {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as any).__kind === 'builtin'
  )
}

// ─── Control-flow signals (thrown to short-circuit execution) ─────────

export class TrainReturnSignal {
  constructor(public readonly value: Value | null) {}
}

export class TrainBreakSignal {}
export class TrainContinueSignal {}

// ─── User-visible runtime exceptions ──────────────────────────────────

/**
 * A train-level exception. Surfaces as catchable RuntimeError /
 * ValidationError / etc in try-catch. JS Error subclass so it can be
 * thrown / caught natively, but the `errorType` carries the train
 * exception class name visible in `catch X as e`.
 */
export class TrainException extends Error {
  override readonly name = 'TrainException'
  constructor(
    public readonly errorType: string,
    message: string,
    public readonly range?: ast.Range,
  ) {
    super(message)
  }
}

/** Programmer error inside the interpreter itself (e.g. unimplemented). */
export class InterpreterBug extends Error {
  override readonly name = 'InterpreterBug'
  constructor(message: string) {
    super(message)
  }
}
