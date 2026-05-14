/**
 * train language parser (CST-based)
 *
 * Built with chevrotain's CstParser. Produces a Concrete Syntax Tree;
 * a later transformer step (M1 end) converts CST → typed AST.
 *
 * This is the M1 PoC subset. Covers enough grammar to parse hello.tr:
 *  - FuncDecl / FaiDecl / ExportDecl
 *  - Type annotations: scalar with range/named constraint, prompt, any
 *  - Block / LetDecl / ReturnStmt / ExprStmt
 *  - Expression: postfix (.member / call), primary (literal / identifier)
 *
 * Subset NOT yet implemented (TODO for later milestones):
 *  - import/const/var top-level decls
 *  - Annotations (@runtime / @adapter / @mock etc.)
 *  - Array/object/enum types; trailing commas
 *  - if/for/while/try-catch/break/continue
 *  - Destructuring (let { a, b } = ...)
 *  - Full expression precedence (+, -, *, /, ==, etc., ternary)
 *  - Assignment statement
 *  - String interpolation lexing
 *  - Trailing commas in lists
 */

import { CstParser, type CstNode, type IToken } from 'chevrotain'
import * as t from './lexer.js'

export class TrainParser extends CstParser {
  constructor() {
    super(t.allTokens, { recoveryEnabled: false })
    this.performSelfAnalysis()
  }

  // ─── Program ──────────────────────────────────────────────────────────

  public program = this.RULE('program', () => {
    this.MANY(() => this.SUBRULE(this.topLevel))
  })

  private topLevel = this.RULE('topLevel', () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.funcDecl) },
      { ALT: () => this.SUBRULE(this.faiDecl) },
      { ALT: () => this.SUBRULE(this.exportDecl) },
    ])
  })

  // ─── Declarations ─────────────────────────────────────────────────────

  private funcDecl = this.RULE('funcDecl', () => {
    this.CONSUME(t.Func)
    this.CONSUME(t.Identifier)
    this.CONSUME(t.LParen)
    this.OPTION(() => this.SUBRULE(this.paramList))
    this.CONSUME(t.RParen)
    this.OPTION2(() => {
      this.CONSUME(t.Arrow)
      this.SUBRULE(this.typeAnnot)
    })
    this.SUBRULE(this.block)
  })

  private faiDecl = this.RULE('faiDecl', () => {
    this.CONSUME(t.Fai)
    this.CONSUME(t.Identifier)
    this.CONSUME(t.LParen)
    this.OPTION(() => this.SUBRULE(this.faiParamList))
    this.CONSUME(t.RParen)
    this.CONSUME(t.Arrow)
    this.SUBRULE(this.faiOutputList)
    this.SUBRULE(this.block)
  })

  private exportDecl = this.RULE('exportDecl', () => {
    this.CONSUME(t.Export)
    this.CONSUME(t.Identifier)
    // TODO: support `export { a, b as c }` / `export func foo() {}` later
  })

  // ─── Parameters / Outputs ─────────────────────────────────────────────

  private paramList = this.RULE('paramList', () => {
    this.SUBRULE(this.param)
    this.MANY(() => {
      this.CONSUME(t.Comma)
      this.SUBRULE2(this.param)
    })
  })

  private param = this.RULE('param', () => {
    this.CONSUME(t.Identifier)
    this.OPTION(() => {
      this.CONSUME(t.Colon)
      this.SUBRULE(this.typeAnnot)
    })
  })

  private faiParamList = this.RULE('faiParamList', () => {
    this.SUBRULE(this.faiParam)
    this.MANY(() => {
      this.CONSUME(t.Comma)
      this.SUBRULE2(this.faiParam)
    })
  })

  private faiParam = this.RULE('faiParam', () => {
    this.CONSUME(t.Identifier)
    this.CONSUME(t.Colon)
    this.SUBRULE(this.typeAnnot)
  })

  private faiOutputList = this.RULE('faiOutputList', () => {
    this.SUBRULE(this.faiOutput)
    this.MANY(() => {
      this.CONSUME(t.Comma)
      this.SUBRULE2(this.faiOutput)
    })
  })

  private faiOutput = this.RULE('faiOutput', () => {
    this.CONSUME(t.Identifier)
    this.CONSUME(t.Colon)
    this.SUBRULE(this.typeAnnot)
  })

  // ─── Type annotations ─────────────────────────────────────────────────
  //
  // Leaf type names (int / float / bool / string / prompt / any) are
  // ordinary identifiers at the lexer layer; the type-checker validates
  // that the identifier is a known type name in type position.

  private typeAnnot = this.RULE('typeAnnot', () => {
    // For PoC: only leaf scalar types. Structural types (enum/array/object)
    // to be added in a later milestone.
    this.SUBRULE(this.scalarType)
  })

  private scalarType = this.RULE('scalarType', () => {
    this.CONSUME(t.Identifier) // int / float / bool / string / prompt / any / etc.
    this.OPTION(() => this.SUBRULE(this.typeConstraint))
  })

  private typeConstraint = this.RULE('typeConstraint', () => {
    this.OR([
      { GATE: () => this.isRangeConstraint(), ALT: () => this.SUBRULE(this.rangeConstraint) },
      { ALT: () => this.SUBRULE(this.namedConstraint) },
    ])
  })

  /** lookahead: range constraint is `<num> Dash <num>`; named is `Identifier Equals ...` */
  private isRangeConstraint(): boolean {
    const t1 = this.LA(1)
    return (
      t1.tokenType === t.IntLit ||
      t1.tokenType === t.FloatLit
    )
  }

  private rangeConstraint = this.RULE('rangeConstraint', () => {
    this.SUBRULE(this.numberLit)
    this.CONSUME(t.Dash)
    this.SUBRULE2(this.numberLit)
  })

  private namedConstraint = this.RULE('namedConstraint', () => {
    this.CONSUME(t.Identifier) // e.g. "maxLen", "minLen", "min", "max", "matches"
    this.CONSUME(t.Equals)
    this.OR([
      { ALT: () => this.SUBRULE(this.numberLit) },
      { ALT: () => this.CONSUME(t.StringLit) },
      // TODO: regex literal /^\d+$/ — not lexed yet
    ])
  })

  private numberLit = this.RULE('numberLit', () => {
    this.OR([
      { ALT: () => this.CONSUME(t.IntLit) },
      { ALT: () => this.CONSUME(t.FloatLit) },
    ])
  })

  // ─── Block / Statements ───────────────────────────────────────────────

  private block = this.RULE('block', () => {
    this.CONSUME(t.LCurly)
    this.MANY(() => this.SUBRULE(this.stmt))
    this.CONSUME(t.RCurly)
  })

  private stmt = this.RULE('stmt', () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.letDecl) },
      { ALT: () => this.SUBRULE(this.returnStmt) },
      { ALT: () => this.SUBRULE(this.exprStmt) },
    ])
  })

  private letDecl = this.RULE('letDecl', () => {
    this.CONSUME(t.Let)
    this.CONSUME(t.Identifier)
    this.OPTION(() => {
      this.CONSUME(t.Colon)
      this.SUBRULE(this.typeAnnot)
    })
    this.OPTION2(() => {
      this.CONSUME(t.Equals)
      this.SUBRULE(this.expr)
    })
  })

  private returnStmt = this.RULE('returnStmt', () => {
    this.CONSUME(t.Return)
    this.OPTION(() => this.SUBRULE(this.expr))
  })

  private exprStmt = this.RULE('exprStmt', () => {
    this.SUBRULE(this.expr)
  })

  // ─── Expressions (minimal subset for PoC) ─────────────────────────────

  private expr = this.RULE('expr', () => {
    this.SUBRULE(this.postfixExpr)
  })

  private postfixExpr = this.RULE('postfixExpr', () => {
    this.SUBRULE(this.primaryExpr)
    this.MANY(() => this.SUBRULE(this.postfixSuffix))
  })

  private postfixSuffix = this.RULE('postfixSuffix', () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(t.Dot)
          this.CONSUME(t.Identifier)
        },
      },
      {
        ALT: () => {
          this.CONSUME(t.LParen)
          this.OPTION(() => this.SUBRULE(this.argList))
          this.CONSUME(t.RParen)
        },
      },
    ])
  })

  private argList = this.RULE('argList', () => {
    this.SUBRULE(this.expr)
    this.MANY(() => {
      this.CONSUME(t.Comma)
      this.SUBRULE2(this.expr)
    })
  })

  private primaryExpr = this.RULE('primaryExpr', () => {
    this.OR([
      { ALT: () => this.CONSUME(t.IntLit) },
      { ALT: () => this.CONSUME(t.FloatLit) },
      { ALT: () => this.CONSUME(t.StringLit) },
      { ALT: () => this.CONSUME(t.True) },
      { ALT: () => this.CONSUME(t.False) },
      { ALT: () => this.CONSUME(t.Null) },
      { ALT: () => this.CONSUME(t.Identifier) },
    ])
  })
}

// Singleton parser instance (chevrotain best practice — performSelfAnalysis is expensive)
export const trainParser = new TrainParser()

export interface ParseResult {
  cst: CstNode | undefined
  lexErrors: ReadonlyArray<unknown>
  parseErrors: ReadonlyArray<unknown>
}

/**
 * Parse train source text. Returns CST + any errors (does not throw on parse errors,
 * to allow IDE-style error reporting).
 */
export function parse(source: string): ParseResult {
  const lexResult = t.trainLexer.tokenize(source)
  trainParser.input = lexResult.tokens as IToken[]
  const cst = trainParser.program()
  return {
    cst,
    lexErrors: lexResult.errors,
    parseErrors: trainParser.errors,
  }
}
