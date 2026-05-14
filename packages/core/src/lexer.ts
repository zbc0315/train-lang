/**
 * train language lexer
 *
 * Token definitions for chevrotain. Covers Part 1-11 of grammar.ebnf.
 *
 * Implementation notes:
 * - Keywords use `longer_alt: Identifier` so that e.g. `int` is keyword but
 *   `integer` is an identifier (chevrotain picks the longer match).
 * - String literals are currently a single token; ${...} interpolation
 *   parsing is deferred to a later milestone (would require lexer modes).
 * - Whitespace and comments are SKIPPED (consumed but not emitted).
 */

import { createToken, Lexer, type TokenType } from 'chevrotain'

// ─── Whitespace / comments (skipped) ─────────────────────────────────────

export const Whitespace = createToken({
  name: 'Whitespace',
  pattern: /[ \t\r\n]+/,
  group: Lexer.SKIPPED,
})

export const LineComment = createToken({
  name: 'LineComment',
  pattern: /\/\/[^\n]*/,
  group: Lexer.SKIPPED,
})

export const BlockComment = createToken({
  name: 'BlockComment',
  pattern: /\/\*[\s\S]*?\*\//,
  group: Lexer.SKIPPED,
})

// ─── Identifier (referenced as longer_alt by all keywords) ────────────────

export const Identifier = createToken({
  name: 'Identifier',
  pattern: /[A-Za-z_][A-Za-z0-9_]*/,
})

// Helper for keyword tokens
const kw = (name: string, literal: string): TokenType =>
  createToken({
    name,
    pattern: new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    longer_alt: Identifier,
  })

// ─── Keywords: module ────────────────────────────────────────────────────

export const Import = kw('Import', 'import')
export const Export = kw('Export', 'export')
export const From = kw('From', 'from')
export const As = kw('As', 'as')

// ─── Keywords: binding ───────────────────────────────────────────────────

export const Const = kw('Const', 'const')
export const Var = kw('Var', 'var')
export const Let = kw('Let', 'let')

// ─── Keywords: function ──────────────────────────────────────────────────

export const Func = kw('Func', 'func')
export const Fai = kw('Fai', 'fai')
export const Return = kw('Return', 'return')

// ─── Keywords: control flow ──────────────────────────────────────────────

export const If = kw('If', 'if')
export const Else = kw('Else', 'else')
export const For = kw('For', 'for')
export const In = kw('In', 'in')
export const While = kw('While', 'while')
export const Break = kw('Break', 'break')
export const Continue = kw('Continue', 'continue')
export const Try = kw('Try', 'try')
export const Catch = kw('Catch', 'catch')

// ─── Keywords: literals ──────────────────────────────────────────────────

export const True = kw('True', 'true')
export const False = kw('False', 'false')
export const Null = kw('Null', 'null')

// ─── Keywords: types (STRUCTURAL constructors only) ──────────────────────
//
// IMPORTANT design decision:
//   Leaf type names (int / float / bool / string / prompt / any) are NOT
//   keywords — they are reserved identifiers, recognized at the type-checker
//   layer rather than the lexer. This is necessary because users WILL want
//   identifiers named `prompt` (e.g. `fai f(prompt: prompt)`) and reserving
//   the name would make the canonical syntax illegal.
//
//   STRUCTURAL constructors (enum / array / object) remain keywords because
//   they begin distinctive grammar shapes (`array<...>`, `enum: ...`,
//   `object{ ... }`) that need lexer-level disambiguation.

export const KwEnum = kw('KwEnum', 'enum')
export const KwArray = kw('KwArray', 'array')
export const KwObject = kw('KwObject', 'object')

// ─── Literals ────────────────────────────────────────────────────────────

// Order matters: FloatLit MUST come before IntLit (more specific wins by length)
export const FloatLit = createToken({
  name: 'FloatLit',
  pattern: /[0-9]+\.[0-9]+/,
})

export const IntLit = createToken({
  name: 'IntLit',
  pattern: /[0-9]+/,
})

// Double-quoted string. Single-quote support planned for non-interpolated form.
// ${...} interpolation will require lexer modes (deferred).
export const StringLit = createToken({
  name: 'StringLit',
  pattern: /"(?:[^"\\]|\\.)*"/,
})

// ─── Operators / Punctuation ─────────────────────────────────────────────

// Multi-char operators MUST come before single-char prefixes they share
export const Arrow = createToken({ name: 'Arrow', pattern: /->/ })
export const FatArrow = createToken({ name: 'FatArrow', pattern: /=>/ })
export const EqEq = createToken({ name: 'EqEq', pattern: /==/ })
export const NotEq = createToken({ name: 'NotEq', pattern: /!=/ })
export const LtEq = createToken({ name: 'LtEq', pattern: /<=/ })
export const GtEq = createToken({ name: 'GtEq', pattern: />=/ })
export const AndAnd = createToken({ name: 'AndAnd', pattern: /&&/ })
export const OrOr = createToken({ name: 'OrOr', pattern: /\|\|/ })
export const PlusEq = createToken({ name: 'PlusEq', pattern: /\+=/ })
export const MinusEq = createToken({ name: 'MinusEq', pattern: /-=/ })
export const StarEq = createToken({ name: 'StarEq', pattern: /\*=/ })
export const SlashEq = createToken({ name: 'SlashEq', pattern: /\/=/ })
export const PercentEq = createToken({ name: 'PercentEq', pattern: /%=/ })
export const Spread = createToken({ name: 'Spread', pattern: /\.\.\./ })

// Single-char punctuation / operators
export const LCurly = createToken({ name: 'LCurly', pattern: /\{/ })
export const RCurly = createToken({ name: 'RCurly', pattern: /\}/ })
export const LParen = createToken({ name: 'LParen', pattern: /\(/ })
export const RParen = createToken({ name: 'RParen', pattern: /\)/ })
export const LBracket = createToken({ name: 'LBracket', pattern: /\[/ })
export const RBracket = createToken({ name: 'RBracket', pattern: /\]/ })
export const LAngle = createToken({ name: 'LAngle', pattern: /</ })
export const RAngle = createToken({ name: 'RAngle', pattern: />/ })
export const Comma = createToken({ name: 'Comma', pattern: /,/ })
export const Colon = createToken({ name: 'Colon', pattern: /:/ })
export const Semicolon = createToken({ name: 'Semicolon', pattern: /;/ })
export const Dot = createToken({ name: 'Dot', pattern: /\./ })
export const Question = createToken({ name: 'Question', pattern: /\?/ })
export const At = createToken({ name: 'At', pattern: /@/ })
export const Plus = createToken({ name: 'Plus', pattern: /\+/ })
export const Dash = createToken({ name: 'Dash', pattern: /-/ })
export const Star = createToken({ name: 'Star', pattern: /\*/ })
export const Slash = createToken({ name: 'Slash', pattern: /\// })
export const Percent = createToken({ name: 'Percent', pattern: /%/ })
export const Bang = createToken({ name: 'Bang', pattern: /!/ })
export const Pipe = createToken({ name: 'Pipe', pattern: /\|/ })
export const Equals = createToken({ name: 'Equals', pattern: /=/ })

// ─── Token order matters: longer / more specific first ────────────────────

export const allTokens = [
  // Skipped first so lexer drops them fast
  Whitespace,
  LineComment,
  BlockComment,

  // Multi-char operators BEFORE their single-char prefixes
  Arrow,
  FatArrow,
  EqEq,
  NotEq,
  LtEq,
  GtEq,
  AndAnd,
  OrOr,
  PlusEq,
  MinusEq,
  StarEq,
  SlashEq,
  PercentEq,
  Spread,

  // Keywords BEFORE Identifier (each declares longer_alt: Identifier).
  // Order constraint: when one keyword is a prefix of another (e.g. `in` vs `int`),
  // the LONGER one MUST come first, otherwise chevrotain's static analysis
  // flags the longer one as unreachable.
  Import,
  Export,
  From,
  As,
  Const,
  Var,
  Let,
  Func,
  Fai,
  Return,
  If,
  Else,
  For,
  While,
  Break,
  Continue,
  Try,
  Catch,
  True,
  False,
  Null,
  // Structural type constructors
  KwEnum,
  KwArray,
  KwObject,
  // Control-flow `in` (other `i*` keywords are not prefixes that collide)
  In,

  // Literals (FloatLit before IntLit)
  FloatLit,
  IntLit,
  StringLit,

  // Identifier last (so keywords win first)
  Identifier,

  // Single-char punctuation
  LCurly,
  RCurly,
  LParen,
  RParen,
  LBracket,
  RBracket,
  LAngle,
  RAngle,
  Comma,
  Colon,
  Semicolon,
  Dot,
  Question,
  At,
  Plus,
  Dash,
  Star,
  Slash,
  Percent,
  Bang,
  Pipe,
  Equals,
]

export const trainLexer = new Lexer(allTokens, {
  positionTracking: 'full',
  ensureOptimizations: false,
})

/**
 * Tokenize source text. Throws on lexer errors.
 */
export function tokenize(source: string) {
  const result = trainLexer.tokenize(source)
  if (result.errors.length > 0) {
    const messages = result.errors.map(
      (e) => `[${e.line}:${e.column}] ${e.message}`,
    )
    throw new Error(`Lexer errors:\n${messages.join('\n')}`)
  }
  return result
}
