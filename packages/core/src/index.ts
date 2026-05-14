/**
 * @train-lang/core — public API
 *
 * train language runtime: lexer, parser, type checker (planned), interpreter (planned).
 *
 * This is the M1 PoC export surface. More will be added as milestones progress.
 */

export { tokenize, trainLexer, allTokens } from './lexer.js'
export { parse, trainParser, type ParseResult } from './parser.js'
