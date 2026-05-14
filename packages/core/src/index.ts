/**
 * @train-lang/core — public API
 *
 * train language runtime: lexer, parser, type checker (planned), interpreter (planned).
 *
 * This is the M1 PoC export surface. More will be added as milestones progress.
 */

export { tokenize, trainLexer, allTokens } from './lexer.js'
export { parse, trainParser, type ParseResult } from './parser.js'
export { buildAst } from './builder.js'
export * as ast from './ast.js'

import { parse } from './parser.js'
import { buildAst } from './builder.js'
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
