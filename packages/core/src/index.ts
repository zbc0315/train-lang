/**
 * @train-lang/core — public API
 *
 * train language runtime: lexer, parser, type checker (planned), interpreter (planned).
 *
 * This is the M1 PoC export surface. More will be added as milestones progress.
 */

export { tokenize, trainLexer, allTokens } from './lexer.js'
export {
  parse,
  parseExpression,
  trainParser,
  type ParseResult,
} from './parser.js'
export { buildAst } from './builder.js'
export * as ast from './ast.js'

export {
  Interpreter,
  runProgram,
  type RunResult,
  type RunOptions,
} from './interpreter.js'

export {
  TrainException,
  TrainReturnSignal,
  TrainBreakSignal,
  TrainContinueSignal,
  type Value,
  type FunctionValue,
  type BuiltinFunction,
  type RuntimeContext,
} from './runtime.js'

export { defaultBuiltinBindings, formatValue } from './builtins.js'

import { parse } from './parser.js'
import { buildAst } from './builder.js'
import { runProgram, type RunOptions, type RunResult } from './interpreter.js'
import { TrainException } from './runtime.js'
import type * as ast from './ast.js'

export interface ParseToAstResult {
  ast: ast.Program | null
  lexErrors: ReadonlyArray<unknown>
  parseErrors: ReadonlyArray<unknown>
}

/**
 * Convenience: parse source text and immediately build the typed AST.
 * AST will be null if there were any lex or parse errors.
 */
export function parseToAst(source: string): ParseToAstResult {
  const result = parse(source)
  const hasErrors =
    result.lexErrors.length > 0 || result.parseErrors.length > 0
  return {
    ast: hasErrors ? null : buildAst(result.cst),
    lexErrors: result.lexErrors,
    parseErrors: result.parseErrors,
  }
}

/**
 * End-to-end: parse + build AST + execute. Useful for tests and the
 * future `train run` CLI command (modulo CLI argument plumbing).
 *
 * Returns the value of the called entry function (or its error).
 * Does not throw on lex/parse errors; returns them in the result.
 */
export interface RunSourceResult {
  ok: boolean
  value: import('./runtime.js').Value | null
  error?: TrainException
  lexErrors: ReadonlyArray<unknown>
  parseErrors: ReadonlyArray<unknown>
}

export async function runSource(
  source: string,
  opts: RunOptions = {},
): Promise<RunSourceResult> {
  const { ast: program, lexErrors, parseErrors } = parseToAst(source)
  if (!program) {
    return {
      ok: false,
      value: null,
      lexErrors,
      parseErrors,
    }
  }
  const result: RunResult = await runProgram(program, opts)
  return {
    ok: result.ok,
    value: result.value,
    error: result.error,
    lexErrors,
    parseErrors,
  }
}

// Also re-export the new helpers so adapter packages and tests can use them.
export { composePrompt } from './prompt-composer.js'
export {
  validateOutputs,
  validateValue,
  composeRetryFeedback,
} from './validation.js'
export {
  typeToDescriptor,
  isPromptType,
  describeType,
} from './type-descriptor.js'
