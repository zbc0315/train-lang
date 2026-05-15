/**
 * CST → typed AST visitor.
 *
 * Uses chevrotain's CST visitor pattern. Each `visit*` method
 * corresponds to one grammar rule in `parser.ts` and produces the
 * matching AST node from `ast.ts`.
 *
 * Conventions:
 * - Method name MUST equal the parser rule name (chevrotain dispatch).
 * - `ctx` carries children grouped by rule name (CstNode[]) or token
 *   name (IToken[]). Optional rules / tokens may be missing entirely;
 *   we read with safe defaults.
 * - All AST nodes carry a `range` derived from the spanning CST/Token.
 */

import type { CstNode, IToken } from 'chevrotain'
import { trainParser, parseExpression } from './parser.js'
import * as ast from './ast.js'

const BaseVisitor = trainParser.getBaseCstVisitorConstructor()

// ─── Range helpers ────────────────────────────────────────────────────

function tokenRange(tok: IToken): ast.Range {
  return {
    startLine: tok.startLine ?? 0,
    startColumn: tok.startColumn ?? 0,
    endLine: tok.endLine ?? 0,
    endColumn: tok.endColumn ?? 0,
    startOffset: tok.startOffset,
    endOffset: tok.endOffset ?? tok.startOffset,
  }
}

function cstRange(cst: CstNode): ast.Range {
  const loc = cst.location
  if (!loc) {
    return {
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 0,
      startOffset: 0,
      endOffset: 0,
    }
  }
  return {
    startLine: loc.startLine ?? 0,
    startColumn: loc.startColumn ?? 0,
    endLine: loc.endLine ?? 0,
    endColumn: loc.endColumn ?? 0,
    startOffset: loc.startOffset,
    endOffset: loc.endOffset ?? loc.startOffset,
  }
}

// ─── Literal value helpers ────────────────────────────────────────────

function unquoteString(raw: string): string {
  // raw is the matched StringLit including surrounding quotes
  const inner = raw.slice(1, -1)
  return unescapeStringBody(inner)
}

function unescapeStringBody(inner: string): string {
  return inner.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case '\\':
        return '\\'
      case '"':
        return '"'
      case "'":
        return "'"
      case '$':
        return '$'
      default:
        return ch
    }
  })
}

/**
 * Scan a string literal body for `${...}` interpolations and split it into
 * alternating chunk / expression segments. Brace nesting inside expressions
 * is tracked so `${ {a: 1}.a }` parses correctly.
 *
 * Limitation: expressions inside `${...}` MUST NOT contain string literals;
 * the surrounding lexer treats the whole string as one token, so nested
 * quotes would have already terminated the string at lex time.
 *
 * Each returned segment carries an offset relative to the START of the
 * raw string body (NOT the source file). Caller offsets those by the
 * original token's startOffset to produce file-relative ranges.
 */
interface RawSegment {
  kind: 'chunk' | 'expr'
  source: string
  startInBody: number
  endInBody: number
}

function splitTemplate(body: string): RawSegment[] {
  // Invariant when output contains any expr: result is strictly
  //   chunk, expr, chunk, expr, ..., chunk
  // i.e. first and last segments are always chunks (possibly empty).
  // When no expr appears, output is a single chunk (possibly empty).
  const segments: RawSegment[] = []
  let buf = ''
  let bufStart = 0
  let i = 0
  const flushChunk = (endPos: number) => {
    segments.push({
      kind: 'chunk',
      source: buf,
      startInBody: bufStart,
      endInBody: endPos,
    })
    buf = ''
    bufStart = endPos
  }
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      // chunk that precedes this interpolation (may be empty)
      flushChunk(i)
      // find matching `}` (track nested {})
      let depth = 1
      let j = i + 2
      while (j < body.length && depth > 0) {
        const ch = body[j]
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) break
        }
        j++
      }
      if (depth !== 0) {
        // Unterminated — recover by treating the rest as one chunk.
        buf += body.slice(i)
        bufStart = i
        i = body.length
        break
      }
      const exprBody = body.slice(i + 2, j)
      segments.push({
        kind: 'expr',
        source: exprBody,
        startInBody: i,
        endInBody: j + 1,
      })
      bufStart = j + 1
      i = j + 1
    } else if (body[i] === '\\' && i + 1 < body.length) {
      buf += body.slice(i, i + 2)
      i += 2
    } else {
      buf += body[i]!
      i++
    }
  }
  // Final flush: keep the "first and last are chunks" invariant.
  // If we have any expr OR no segments yet, emit a chunk for the tail
  // (possibly empty). If we have only a partially-buffered plain string
  // and no segments, the empty flush still produces the single chunk.
  const hasExpr = segments.some((s) => s.kind === 'expr')
  if (hasExpr || segments.length === 0) {
    flushChunk(body.length)
  } else if (buf.length > 0) {
    // pure literal case where buffer was carried past a recovery path
    flushChunk(body.length)
  }
  return segments
}

/**
 * Build either a plain StringLit (no interpolation) or a TemplateString
 * (one or more `${...}`) from the source token. Offsets in returned
 * sub-ranges are relative to the source file (using `tok.startOffset` +
 * 1 to skip the opening quote).
 */
function buildStringExpr(tok: IToken): ast.StringLit | ast.TemplateString {
  const raw = tok.image
  const body = raw.slice(1, -1) // strip surrounding quotes
  const fullRange = tokenRange(tok)
  const segs = splitTemplate(body)

  if (!segs.some((s) => s.kind === 'expr')) {
    // Pure literal — return StringLit
    const merged = segs.map((s) => s.source).join('')
    return {
      kind: 'StringLit',
      value: unescapeStringBody(merged),
      range: fullRange,
    }
  }

  // Has interpolation — build TemplateString
  const bodyOffset = tok.startOffset + 1 // skip opening quote
  const parts: ast.TemplatePart[] = segs.map((seg): ast.TemplatePart => {
    if (seg.kind === 'chunk') {
      return {
        kind: 'TemplateChunk',
        value: unescapeStringBody(seg.source),
        range: subRange(fullRange, bodyOffset, seg.startInBody, seg.endInBody),
      }
    }
    // expr — recursively parse it via the parser's exprEntry
    const result = parseExpression(seg.source)
    if (
      result.lexErrors.length > 0 ||
      result.parseErrors.length > 0 ||
      !result.cst
    ) {
      // emit a fallback: empty string chunk with the broken expr's text.
      // In a future revision we should propagate diagnostics up.
      return {
        kind: 'TemplateChunk',
        value: '${' + seg.source + '}',
        range: subRange(fullRange, bodyOffset, seg.startInBody, seg.endInBody),
      }
    }
    const innerExpr = astBuilder.visit(result.cst) as ast.Expr
    return {
      kind: 'TemplateExpr',
      expr: innerExpr,
      range: subRange(fullRange, bodyOffset, seg.startInBody, seg.endInBody),
    }
  })
  return {
    kind: 'TemplateString',
    parts,
    range: fullRange,
  }
}

/** Produce a Range for a sub-region of a single-line-ish source token.
 *  Sufficient for now (no per-segment line/column tracking inside templates). */
function subRange(
  full: ast.Range,
  bodyOffset: number,
  startInBody: number,
  endInBody: number,
): ast.Range {
  return {
    startLine: full.startLine,
    startColumn: full.startColumn,
    endLine: full.endLine,
    endColumn: full.endColumn,
    startOffset: bodyOffset + startInBody,
    endOffset: bodyOffset + endInBody,
  }
}

function stripAtPrefix(name: string): string {
  return name.startsWith('@') ? name.slice(1) : name
}

// ─── Visitor implementation ───────────────────────────────────────────

class TrainAstBuilder extends BaseVisitor {
  constructor() {
    super()
    this.validateVisitor()
  }

  // ─── Program ────────────────────────────────────────────────────────

  /** Used by buildStringExpr → parseExpression for ${...} bodies. */
  exprEntry(ctx: any): ast.Expr {
    return this.visit(ctx.expr[0]) as ast.Expr
  }

  program(ctx: any, _params?: unknown): ast.Program {
    const cst = (ctx.$cstNode ?? undefined) as CstNode | undefined
    const items = ((ctx.topLevel ?? []) as CstNode[]).map(
      (c): ast.TopLevel => this.visit(c) as ast.TopLevel,
    )
    return {
      kind: 'Program',
      items,
      range: cst ? cstRange(cst) : emptyRange(items),
    }
  }

  topLevel(ctx: any): ast.TopLevel {
    if (ctx.importDecl) return this.visit(ctx.importDecl[0])
    if (ctx.runtimeAnnotation) return this.visit(ctx.runtimeAnnotation[0])
    if (ctx.constDecl) return this.visit(ctx.constDecl[0])
    if (ctx.varDecl) return this.visit(ctx.varDecl[0])
    if (ctx.annotatedDecl) return this.visit(ctx.annotatedDecl[0])
    if (ctx.funcDecl) return this.visit(ctx.funcDecl[0])
    if (ctx.faiDecl) return this.visit(ctx.faiDecl[0])
    if (ctx.exportDecl) return this.visit(ctx.exportDecl[0])
    throw new Error('unreachable: topLevel had no matching alternative')
  }

  // ─── Imports ────────────────────────────────────────────────────────

  importDecl(ctx: any): ast.Import {
    const clause = this.visit(ctx.importClause[0]) as
      | ast.NamedImports
      | ast.NamespaceImport
    const sourceTok = (ctx.StringLit as IToken[])[0]!
    const versionTok = (ctx.AtName as IToken[] | undefined)?.[0]
    const importTok = (ctx.Import as IToken[])[0]!
    const endTok = versionTok ?? sourceTok
    return {
      kind: 'Import',
      clause,
      source: unquoteString(sourceTok.image),
      version: versionTok ? versionTok.image.slice(1) : null,
      range: spanTokens(importTok, endTok),
    }
  }

  importClause(ctx: any): ast.NamedImports | ast.NamespaceImport {
    if (ctx.namedImports) return this.visit(ctx.namedImports[0])
    return this.visit(ctx.namespaceImport[0])
  }

  namedImports(ctx: any): ast.NamedImports {
    const specs = ((ctx.importSpec ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.ImportSpec,
    )
    const lcurly = (ctx.LCurly as IToken[])[0]!
    const rcurly = (ctx.RCurly as IToken[])[0]!
    return {
      kind: 'NamedImports',
      specs,
      range: spanTokens(lcurly, rcurly),
    }
  }

  importSpec(ctx: any): ast.ImportSpec {
    const ids = ctx.Identifier as IToken[]
    const name = ids[0]!.image
    const alias = ids.length > 1 ? ids[1]!.image : null
    return {
      kind: 'ImportSpec',
      name,
      alias,
      range: spanTokens(ids[0]!, ids[ids.length - 1]!),
    }
  }

  namespaceImport(ctx: any): ast.NamespaceImport {
    const star = (ctx.Star as IToken[])[0]!
    const alias = (ctx.Identifier as IToken[])[0]!
    return {
      kind: 'NamespaceImport',
      alias: alias.image,
      range: spanTokens(star, alias),
    }
  }

  // ─── Annotations ────────────────────────────────────────────────────

  runtimeAnnotation(ctx: any): ast.RuntimeAnnotation {
    const name = (ctx.AtName as IToken[])[0]!
    const argsCst = ctx.annoArgList?.[0] as CstNode | undefined
    const args = argsCst ? (this.visit(argsCst) as ast.AnnotationArg[]) : []
    const rparen = (ctx.RParen as IToken[] | undefined)?.[0]
    const endTok = rparen ?? name
    return {
      kind: 'RuntimeAnnotation',
      name: stripAtPrefix(name.image),
      args,
      range: spanTokens(name, endTok),
    }
  }

  declAnnotation(ctx: any): ast.Annotation {
    const name = (ctx.AtName as IToken[])[0]!
    const argsCst = ctx.annoArgList?.[0] as CstNode | undefined
    const args = argsCst ? (this.visit(argsCst) as ast.AnnotationArg[]) : []
    const rparen = (ctx.RParen as IToken[] | undefined)?.[0]
    const endTok = rparen ?? name
    return {
      kind: 'Annotation',
      name: stripAtPrefix(name.image),
      args,
      range: spanTokens(name, endTok),
    }
  }

  annoArgList(ctx: any): ast.AnnotationArg[] {
    return ((ctx.annoArg ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.AnnotationArg,
    )
  }

  annoArg(ctx: any): ast.AnnotationArg {
    const keyTok = (ctx.Identifier as IToken[] | undefined)?.[0]
    const lits = ctx.literal as CstNode[]
    const literalCst = lits[0]!
    const value = this.visit(literalCst) as ast.Literal | ast.TemplateString
    const startTok = keyTok ?? findFirstToken(literalCst)
    const endRange = value.range
    return {
      kind: 'AnnotationArg',
      key: keyTok ? keyTok.image : null,
      value,
      range: {
        startLine: startTok?.startLine ?? endRange.startLine,
        startColumn: startTok?.startColumn ?? endRange.startColumn,
        endLine: endRange.endLine,
        endColumn: endRange.endColumn,
        startOffset: startTok?.startOffset ?? endRange.startOffset,
        endOffset: endRange.endOffset,
      },
    }
  }

  annotatedDecl(
    ctx: any,
  ): ast.FuncDecl | ast.FaiDecl {
    const annotations = ((ctx.declAnnotation ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.Annotation,
    )
    let decl: ast.FuncDecl | ast.FaiDecl
    if (ctx.funcDecl) decl = this.visit(ctx.funcDecl[0]) as ast.FuncDecl
    else decl = this.visit(ctx.faiDecl[0]) as ast.FaiDecl
    return { ...decl, annotations }
  }

  // ─── Top-level declarations ─────────────────────────────────────────

  constDecl(ctx: any): ast.ConstDecl {
    const constTok = (ctx.Const as IToken[])[0]!
    const id = (ctx.Identifier as IToken[])[0]!
    const type = this.visit(ctx.declTypeAnnot[0]) as ast.TypeAnnot
    const value = this.visit(ctx.expr[0]) as ast.Expr
    return {
      kind: 'ConstDecl',
      name: id.image,
      type,
      value,
      range: spanFromTokenToRange(constTok, value.range),
    }
  }

  varDecl(ctx: any): ast.VarDecl {
    const varTok = (ctx.Var as IToken[])[0]!
    const id = (ctx.Identifier as IToken[])[0]!
    const type = this.visit(ctx.declTypeAnnot[0]) as ast.TypeAnnot
    const init = ctx.expr ? (this.visit(ctx.expr[0]) as ast.Expr) : null
    const endRange = init?.range ?? type.range
    return {
      kind: 'VarDecl',
      name: id.image,
      type,
      init,
      range: spanFromTokenToRange(varTok, endRange),
    }
  }

  funcDecl(ctx: any): ast.FuncDecl {
    const funcTok = (ctx.Func as IToken[])[0]!
    const id = (ctx.Identifier as IToken[])[0]!
    const params = ctx.paramList
      ? (this.visit(ctx.paramList[0]) as ast.Param[])
      : []
    const returnType = ctx.typeAnnot
      ? (this.visit(ctx.typeAnnot[0]) as ast.TypeAnnot)
      : null
    const body = this.visit(ctx.block[0]) as ast.Block
    return {
      kind: 'FuncDecl',
      annotations: [],
      name: id.image,
      params,
      returnType,
      body,
      range: spanFromTokenToRange(funcTok, body.range),
    }
  }

  faiDecl(ctx: any): ast.FaiDecl {
    const faiTok = (ctx.Fai as IToken[])[0]!
    const id = (ctx.Identifier as IToken[])[0]!
    const params = ctx.faiParamList
      ? (this.visit(ctx.faiParamList[0]) as ast.FaiParam[])
      : []
    const outputs = this.visit(ctx.faiOutputList[0]) as ast.FaiOutput[]
    const body = this.visit(ctx.block[0]) as ast.Block
    return {
      kind: 'FaiDecl',
      annotations: [],
      name: id.image,
      params,
      outputs,
      body,
      range: spanFromTokenToRange(faiTok, body.range),
    }
  }

  exportDecl(ctx: any): ast.ExportDecl {
    const exportTok = (ctx.Export as IToken[])[0]!
    let target: ast.ExportNames | ast.FuncDecl | ast.FaiDecl
    if (ctx.exportNames) target = this.visit(ctx.exportNames[0])
    else if (ctx.funcDecl) target = this.visit(ctx.funcDecl[0])
    else target = this.visit(ctx.faiDecl[0])
    return {
      kind: 'ExportDecl',
      target,
      range: spanFromTokenToRange(exportTok, target.range),
    }
  }

  exportNames(ctx: any): ast.ExportNames {
    const specs = ((ctx.exportSpec ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.ExportSpec,
    )
    if (specs.length === 0) {
      return {
        kind: 'ExportNames',
        specs: [],
        range: emptyRange([]),
      }
    }
    const first = specs[0]!.range
    const last = specs[specs.length - 1]!.range
    return {
      kind: 'ExportNames',
      specs,
      range: spanRanges(first, last),
    }
  }

  exportSpec(ctx: any): ast.ExportSpec {
    const ids = ctx.Identifier as IToken[]
    const name = ids[0]!.image
    const alias = ids.length > 1 ? ids[1]!.image : null
    return {
      kind: 'ExportSpec',
      name,
      alias,
      range: spanTokens(ids[0]!, ids[ids.length - 1]!),
    }
  }

  // ─── Parameters / Outputs ───────────────────────────────────────────

  paramList(ctx: any): ast.Param[] {
    return ((ctx.param ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.Param,
    )
  }

  param(ctx: any): ast.Param {
    const id = (ctx.Identifier as IToken[])[0]!
    const type = ctx.typeAnnot
      ? (this.visit(ctx.typeAnnot[0]) as ast.TypeAnnot)
      : null
    const endRange = type?.range ?? tokenRange(id)
    return {
      kind: 'Param',
      name: id.image,
      type,
      range: spanFromTokenToRange(id, endRange),
    }
  }

  faiParamList(ctx: any): ast.FaiParam[] {
    return ((ctx.faiParam ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.FaiParam,
    )
  }

  faiParam(ctx: any): ast.FaiParam {
    const id = (ctx.Identifier as IToken[])[0]!
    const type = this.visit(ctx.typeAnnot[0]) as ast.TypeAnnot
    return {
      kind: 'FaiParam',
      name: id.image,
      type,
      range: spanFromTokenToRange(id, type.range),
    }
  }

  faiOutputList(ctx: any): ast.FaiOutput[] {
    return (ctx.faiOutput as CstNode[]).map(
      (c) => this.visit(c) as ast.FaiOutput,
    )
  }

  faiOutput(ctx: any): ast.FaiOutput {
    const id = (ctx.Identifier as IToken[])[0]!
    const type = this.visit(ctx.typeAnnot[0]) as ast.TypeAnnot
    return {
      kind: 'FaiOutput',
      name: id.image,
      type,
      range: spanFromTokenToRange(id, type.range),
    }
  }

  // ─── Types ──────────────────────────────────────────────────────────

  typeAnnot(ctx: any): ast.TypeAnnot {
    if (ctx.enumType) return this.visit(ctx.enumType[0])
    if (ctx.arrayType) return this.visit(ctx.arrayType[0])
    if (ctx.objectType) return this.visit(ctx.objectType[0])
    return this.visit(ctx.scalarType[0])
  }

  // Variant for let/var/const decl types: same AST shape as typeAnnot
  // but scalar/array sub-rules don't allow trailing named constraints
  // (those would silently swallow the next statement). Constraints
  // belong on fai outputs / func params, not local bindings.
  declTypeAnnot(ctx: any): ast.TypeAnnot {
    if (ctx.enumType) return this.visit(ctx.enumType[0])
    if (ctx.declArrayType) return this.visit(ctx.declArrayType[0])
    if (ctx.objectType) return this.visit(ctx.objectType[0])
    return this.visit(ctx.declScalarType[0])
  }

  declScalarType(ctx: any): ast.ScalarType {
    const id = (ctx.Identifier as IToken[])[0]!
    return {
      kind: 'ScalarType',
      name: id.image,
      constraint: null,
      range: tokenRange(id),
    }
  }

  declArrayType(ctx: any): ast.ArrayType {
    const arrTok = (ctx.KwArray as IToken[])[0]!
    const element = this.visit(ctx.typeAnnot[0]) as ast.TypeAnnot
    const rangle = (ctx.RAngle as IToken[])[0]!
    return {
      kind: 'ArrayType',
      element,
      constraint: null,
      range: spanFromTokenToRange(arrTok, tokenRange(rangle)),
    }
  }

  scalarType(ctx: any): ast.ScalarType {
    const id = (ctx.Identifier as IToken[])[0]!
    const constraint = ctx.typeConstraint
      ? (this.visit(ctx.typeConstraint[0]) as ast.TypeConstraint)
      : null
    const endRange = constraint?.range ?? tokenRange(id)
    return {
      kind: 'ScalarType',
      name: id.image,
      constraint,
      range: spanFromTokenToRange(id, endRange),
    }
  }

  enumType(ctx: any): ast.EnumType {
    const enumTok = (ctx.KwEnum as IToken[])[0]!
    const variants = (ctx.Identifier as IToken[]).map((t) => t.image)
    const lastId = (ctx.Identifier as IToken[]).at(-1)!
    return {
      kind: 'EnumType',
      variants,
      range: spanTokens(enumTok, lastId),
    }
  }

  arrayType(ctx: any): ast.ArrayType {
    const arrTok = (ctx.KwArray as IToken[])[0]!
    const element = this.visit(ctx.typeAnnot[0]) as ast.TypeAnnot
    const rangle = (ctx.RAngle as IToken[])[0]!
    const constraint = ctx.namedConstraint
      ? (this.visit(ctx.namedConstraint[0]) as ast.NamedConstraint)
      : null
    const endRange = constraint?.range ?? tokenRange(rangle)
    return {
      kind: 'ArrayType',
      element,
      constraint,
      range: spanFromTokenToRange(arrTok, endRange),
    }
  }

  objectType(ctx: any): ast.ObjectType {
    const objTok = (ctx.KwObject as IToken[])[0]!
    const rcurly = (ctx.RCurly as IToken[])[0]!
    const fields = ((ctx.objectTypeField ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.ObjectTypeField,
    )
    return {
      kind: 'ObjectType',
      fields,
      range: spanTokens(objTok, rcurly),
    }
  }

  objectTypeField(ctx: any): ast.ObjectTypeField {
    const id = (ctx.Identifier as IToken[])[0]!
    const type = this.visit(ctx.typeAnnot[0]) as ast.TypeAnnot
    return {
      kind: 'ObjectTypeField',
      name: id.image,
      type,
      range: spanFromTokenToRange(id, type.range),
    }
  }

  typeConstraint(ctx: any): ast.TypeConstraint {
    if (ctx.rangeConstraint) return this.visit(ctx.rangeConstraint[0])
    return this.visit(ctx.namedConstraint[0])
  }

  rangeConstraint(ctx: any): ast.RangeConstraint {
    const nums = (ctx.numberLit as CstNode[]).map(
      (c) => this.visit(c) as { value: number; range: ast.Range },
    )
    return {
      kind: 'RangeConstraint',
      min: nums[0]!.value,
      max: nums[1]!.value,
      range: spanRanges(nums[0]!.range, nums[1]!.range),
    }
  }

  namedConstraint(ctx: any): ast.NamedConstraint {
    const key = (ctx.Identifier as IToken[])[0]!
    let value: number | string
    let endRange: ast.Range
    if (ctx.numberLit) {
      const n = this.visit(ctx.numberLit[0]) as {
        value: number
        range: ast.Range
      }
      value = n.value
      endRange = n.range
    } else {
      const sTok = (ctx.StringLit as IToken[])[0]!
      value = unquoteString(sTok.image)
      endRange = tokenRange(sTok)
    }
    return {
      kind: 'NamedConstraint',
      key: key.image,
      value,
      range: spanFromTokenToRange(key, endRange),
    }
  }

  numberLit(ctx: any): { value: number; range: ast.Range } {
    if (ctx.IntLit) {
      const tok = (ctx.IntLit as IToken[])[0]!
      return { value: Number.parseInt(tok.image, 10), range: tokenRange(tok) }
    }
    const tok = (ctx.FloatLit as IToken[])[0]!
    return { value: Number.parseFloat(tok.image), range: tokenRange(tok) }
  }

  // ─── Block / Statements ─────────────────────────────────────────────

  block(ctx: any): ast.Block {
    const lcurly = (ctx.LCurly as IToken[])[0]!
    const rcurly = (ctx.RCurly as IToken[])[0]!
    const stmts = ((ctx.stmt ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.Stmt,
    )
    return { kind: 'Block', stmts, range: spanTokens(lcurly, rcurly) }
  }

  stmt(ctx: any): ast.Stmt {
    if (ctx.letDecl) return this.visit(ctx.letDecl[0])
    if (ctx.ifStmt) return this.visit(ctx.ifStmt[0])
    if (ctx.forStmt) return this.visit(ctx.forStmt[0])
    if (ctx.whileStmt) return this.visit(ctx.whileStmt[0])
    if (ctx.tryStmt) return this.visit(ctx.tryStmt[0])
    if (ctx.breakStmt) return this.visit(ctx.breakStmt[0])
    if (ctx.continueStmt) return this.visit(ctx.continueStmt[0])
    if (ctx.returnStmt) return this.visit(ctx.returnStmt[0])
    if (ctx.assignment) return this.visit(ctx.assignment[0])
    if (ctx.exprStmt) return this.visit(ctx.exprStmt[0])
    throw new Error('unreachable: stmt had no matching alternative')
  }

  letDecl(ctx: any): ast.LetDecl {
    const letTok = (ctx.Let as IToken[])[0]!
    const target = this.visit(ctx.letTarget[0]) as ast.LetTarget
    const type = ctx.declTypeAnnot
      ? (this.visit(ctx.declTypeAnnot[0]) as ast.TypeAnnot)
      : null
    const init = ctx.expr ? (this.visit(ctx.expr[0]) as ast.Expr) : null
    const endRange = init?.range ?? type?.range ?? target.range
    return {
      kind: 'LetDecl',
      target,
      type,
      init,
      range: spanFromTokenToRange(letTok, endRange),
    }
  }

  letTarget(ctx: any): ast.LetTarget {
    if (ctx.Identifier) {
      const id = (ctx.Identifier as IToken[])[0]!
      return { kind: 'IdentTarget', name: id.image, range: tokenRange(id) }
    }
    if (ctx.objectDestruct) return this.visit(ctx.objectDestruct[0])
    return this.visit(ctx.arrayDestruct[0])
  }

  objectDestruct(ctx: any): ast.ObjectDestruct {
    const lcurly = (ctx.LCurly as IToken[])[0]!
    const rcurly = (ctx.RCurly as IToken[])[0]!
    const fields = ((ctx.destructField ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.DestructField,
    )
    return {
      kind: 'ObjectDestruct',
      fields,
      range: spanTokens(lcurly, rcurly),
    }
  }

  destructField(ctx: any): ast.DestructField {
    const ids = ctx.Identifier as IToken[]
    const source = ids[0]!.image
    const local = ids.length > 1 ? ids[1]!.image : source
    return {
      kind: 'DestructField',
      source,
      local,
      range: spanTokens(ids[0]!, ids[ids.length - 1]!),
    }
  }

  arrayDestruct(ctx: any): ast.ArrayDestruct {
    const lbracket = (ctx.LBracket as IToken[])[0]!
    const rbracket = (ctx.RBracket as IToken[])[0]!
    const names = (ctx.Identifier as IToken[]).map((t) => t.image)
    return {
      kind: 'ArrayDestruct',
      names,
      range: spanTokens(lbracket, rbracket),
    }
  }

  assignment(ctx: any): ast.Assignment {
    const target = this.visit(ctx.lvalue[0]) as ast.LValue
    const op = this.visit(ctx.assignOp[0]) as ast.AssignOp
    const value = this.visit(ctx.expr[0]) as ast.Expr
    return {
      kind: 'Assignment',
      target,
      op,
      value,
      range: spanRanges(target.range, value.range),
    }
  }

  lvalue(ctx: any): ast.LValue {
    const id = (ctx.Identifier as IToken[])[0]!
    const suffixes = ((ctx.lvalueSuffix ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.LValueSuffix,
    )
    const endRange =
      suffixes.length > 0 ? suffixes[suffixes.length - 1]!.range : tokenRange(id)
    return {
      kind: 'LValue',
      base: id.image,
      suffixes,
      range: spanFromTokenToRange(id, endRange),
    }
  }

  lvalueSuffix(ctx: any): ast.LValueSuffix {
    if (ctx.Dot) {
      const dot = (ctx.Dot as IToken[])[0]!
      const id = (ctx.Identifier as IToken[])[0]!
      return {
        kind: 'MemberSuffix',
        name: id.image,
        range: spanTokens(dot, id),
      }
    }
    const lbracket = (ctx.LBracket as IToken[])[0]!
    const rbracket = (ctx.RBracket as IToken[])[0]!
    const index = this.visit(ctx.expr[0]) as ast.Expr
    return {
      kind: 'IndexSuffix',
      index,
      range: spanTokens(lbracket, rbracket),
    }
  }

  assignOp(ctx: any): ast.AssignOp {
    if (ctx.Equals) return '='
    if (ctx.PlusEq) return '+='
    if (ctx.MinusEq) return '-='
    if (ctx.StarEq) return '*='
    if (ctx.SlashEq) return '/='
    return '%='
  }

  ifStmt(ctx: any): ast.IfStmt {
    const ifTok = (ctx.If as IToken[])[0]!
    const exprs = ctx.expr as CstNode[]
    const blocks = ctx.block as CstNode[]
    const cond = this.visit(exprs[0]!) as ast.Expr
    const then = this.visit(blocks[0]!) as ast.Block

    // remaining expr/block pairs (each "else if") + optional final else block
    // grammar: ifStmt has: 1 cond expr + 1 then block + N elif-pairs (expr+block) + optional else block
    const elifs: ast.ElseIf[] = []
    for (let i = 1; i < exprs.length; i++) {
      const eCond = this.visit(exprs[i]!) as ast.Expr
      const eBody = this.visit(blocks[i]!) as ast.Block
      elifs.push({
        kind: 'ElseIf',
        cond: eCond,
        body: eBody,
        range: spanRanges(eCond.range, eBody.range),
      })
    }
    // if there is a trailing else, its block is the last one in `blocks`
    let otherwise: ast.Block | null = null
    if (blocks.length > exprs.length) {
      otherwise = this.visit(blocks[blocks.length - 1]!) as ast.Block
    }

    const endRange = otherwise?.range ?? elifs.at(-1)?.range ?? then.range
    return {
      kind: 'IfStmt',
      cond,
      then,
      elifs,
      otherwise,
      range: spanFromTokenToRange(ifTok, endRange),
    }
  }

  forStmt(ctx: any): ast.ForStmt {
    const forTok = (ctx.For as IToken[])[0]!
    const binding = (ctx.Identifier as IToken[])[0]!.image
    const iterable = this.visit(ctx.expr[0]) as ast.Expr
    const body = this.visit(ctx.block[0]) as ast.Block
    return {
      kind: 'ForStmt',
      binding,
      iterable,
      body,
      range: spanFromTokenToRange(forTok, body.range),
    }
  }

  whileStmt(ctx: any): ast.WhileStmt {
    const whileTok = (ctx.While as IToken[])[0]!
    const cond = this.visit(ctx.expr[0]) as ast.Expr
    const body = this.visit(ctx.block[0]) as ast.Block
    return {
      kind: 'WhileStmt',
      cond,
      body,
      range: spanFromTokenToRange(whileTok, body.range),
    }
  }

  tryStmt(ctx: any): ast.TryStmt {
    const tryTok = (ctx.Try as IToken[])[0]!
    const body = this.visit(ctx.block[0]) as ast.Block
    const catches = (ctx.catchClause as CstNode[]).map(
      (c) => this.visit(c) as ast.CatchClause,
    )
    const endRange = catches.at(-1)?.range ?? body.range
    return {
      kind: 'TryStmt',
      body,
      catches,
      range: spanFromTokenToRange(tryTok, endRange),
    }
  }

  catchClause(ctx: any): ast.CatchClause {
    const catchTok = (ctx.Catch as IToken[])[0]!
    const ids = ctx.Identifier as IToken[]
    const errorType = ids[0]!.image
    const binding = ids.length > 1 ? ids[1]!.image : null
    const body = this.visit(ctx.block[0]) as ast.Block
    return {
      kind: 'CatchClause',
      errorType,
      binding,
      body,
      range: spanFromTokenToRange(catchTok, body.range),
    }
  }

  breakStmt(ctx: any): ast.BreakStmt {
    const tok = (ctx.Break as IToken[])[0]!
    return { kind: 'BreakStmt', range: tokenRange(tok) }
  }

  continueStmt(ctx: any): ast.ContinueStmt {
    const tok = (ctx.Continue as IToken[])[0]!
    return { kind: 'ContinueStmt', range: tokenRange(tok) }
  }

  returnStmt(ctx: any): ast.ReturnStmt {
    const retTok = (ctx.Return as IToken[])[0]!
    const value = ctx.expr ? (this.visit(ctx.expr[0]) as ast.Expr) : null
    return {
      kind: 'ReturnStmt',
      value,
      range: value ? spanFromTokenToRange(retTok, value.range) : tokenRange(retTok),
    }
  }

  exprStmt(ctx: any): ast.ExprStmt {
    const expr = this.visit(ctx.expr[0]) as ast.Expr
    return { kind: 'ExprStmt', expr, range: expr.range }
  }

  // ─── Expressions ────────────────────────────────────────────────────

  expr(ctx: any): ast.Expr {
    return this.visit(ctx.ternaryExpr[0])
  }

  ternaryExpr(ctx: any): ast.Expr {
    const cond = this.visit(ctx.logicalOrExpr[0]) as ast.Expr
    if (!ctx.expr) return cond
    const [thenCst, elseCst] = ctx.expr as CstNode[]
    const thenExpr = this.visit(thenCst!) as ast.Expr
    const elseExpr = this.visit(elseCst!) as ast.Expr
    return {
      kind: 'TernaryExpr',
      cond,
      then: thenExpr,
      otherwise: elseExpr,
      range: spanRanges(cond.range, elseExpr.range),
    }
  }

  logicalOrExpr(ctx: any): ast.Expr {
    return buildLeftAssocBinary(
      (ctx.logicalAndExpr as CstNode[]).map((c) => this.visit(c) as ast.Expr),
      (ctx.OrOr as IToken[] | undefined ?? []).map(() => '||' as const),
    )
  }

  logicalAndExpr(ctx: any): ast.Expr {
    return buildLeftAssocBinary(
      (ctx.equalityExpr as CstNode[]).map((c) => this.visit(c) as ast.Expr),
      (ctx.AndAnd as IToken[] | undefined ?? []).map(() => '&&' as const),
    )
  }

  equalityExpr(ctx: any): ast.Expr {
    const operands = (ctx.comparisonExpr as CstNode[]).map(
      (c) => this.visit(c) as ast.Expr,
    )
    const ops = combineOps(ctx, [['EqEq', '=='], ['NotEq', '!=']])
    return buildLeftAssocBinary(operands, ops)
  }

  comparisonExpr(ctx: any): ast.Expr {
    const operands = (ctx.additiveExpr as CstNode[]).map(
      (c) => this.visit(c) as ast.Expr,
    )
    const ops = combineOps(ctx, [
      ['LAngle', '<'],
      ['LtEq', '<='],
      ['RAngle', '>'],
      ['GtEq', '>='],
    ])
    return buildLeftAssocBinary(operands, ops)
  }

  additiveExpr(ctx: any): ast.Expr {
    const operands = (ctx.multiplicativeExpr as CstNode[]).map(
      (c) => this.visit(c) as ast.Expr,
    )
    const ops = combineOps(ctx, [['Plus', '+'], ['Dash', '-']])
    return buildLeftAssocBinary(operands, ops)
  }

  multiplicativeExpr(ctx: any): ast.Expr {
    const operands = (ctx.unaryExpr as CstNode[]).map(
      (c) => this.visit(c) as ast.Expr,
    )
    const ops = combineOps(ctx, [
      ['Star', '*'],
      ['Slash', '/'],
      ['Percent', '%'],
    ])
    return buildLeftAssocBinary(operands, ops)
  }

  unaryExpr(ctx: any): ast.Expr {
    const operand = this.visit(ctx.postfixExpr[0]) as ast.Expr
    if (ctx.Dash) {
      const dash = (ctx.Dash as IToken[])[0]!
      return {
        kind: 'UnaryExpr',
        op: '-',
        operand,
        range: spanFromTokenToRange(dash, operand.range),
      }
    }
    if (ctx.Bang) {
      const bang = (ctx.Bang as IToken[])[0]!
      return {
        kind: 'UnaryExpr',
        op: '!',
        operand,
        range: spanFromTokenToRange(bang, operand.range),
      }
    }
    return operand
  }

  postfixExpr(ctx: any): ast.Expr {
    let current = this.visit(ctx.primaryExpr[0]) as ast.Expr
    const suffixes = (ctx.postfixSuffix ?? []) as CstNode[]
    for (const sufCst of suffixes) {
      const suf = this.visit(sufCst) as
        | { tag: 'member'; name: string; range: ast.Range }
        | { tag: 'index'; index: ast.Expr; range: ast.Range }
        | { tag: 'call'; args: ast.Expr[]; range: ast.Range }
      if (suf.tag === 'member') {
        current = {
          kind: 'MemberExpr',
          object: current,
          property: suf.name,
          range: spanRanges(current.range, suf.range),
        }
      } else if (suf.tag === 'index') {
        current = {
          kind: 'IndexExpr',
          object: current,
          index: suf.index,
          range: spanRanges(current.range, suf.range),
        }
      } else {
        current = {
          kind: 'CallExpr',
          callee: current,
          args: suf.args,
          range: spanRanges(current.range, suf.range),
        }
      }
    }
    return current
  }

  postfixSuffix(ctx: any):
    | { tag: 'member'; name: string; range: ast.Range }
    | { tag: 'index'; index: ast.Expr; range: ast.Range }
    | { tag: 'call'; args: ast.Expr[]; range: ast.Range } {
    if (ctx.Dot) {
      const dot = (ctx.Dot as IToken[])[0]!
      const id = (ctx.Identifier as IToken[])[0]!
      return { tag: 'member', name: id.image, range: spanTokens(dot, id) }
    }
    if (ctx.LBracket) {
      const lb = (ctx.LBracket as IToken[])[0]!
      const rb = (ctx.RBracket as IToken[])[0]!
      const index = this.visit(ctx.expr[0]) as ast.Expr
      return { tag: 'index', index, range: spanTokens(lb, rb) }
    }
    const lp = (ctx.LParen as IToken[])[0]!
    const rp = (ctx.RParen as IToken[])[0]!
    const args = ctx.argList
      ? (this.visit(ctx.argList[0]) as ast.Expr[])
      : []
    return { tag: 'call', args, range: spanTokens(lp, rp) }
  }

  argList(ctx: any): ast.Expr[] {
    return (ctx.expr as CstNode[]).map((c) => this.visit(c) as ast.Expr)
  }

  primaryExpr(ctx: any): ast.Expr {
    if (ctx.literal) return this.visit(ctx.literal[0])
    if (ctx.Identifier) {
      const id = (ctx.Identifier as IToken[])[0]!
      return { kind: 'IdentExpr', name: id.image, range: tokenRange(id) }
    }
    if (ctx.arrayLit) return this.visit(ctx.arrayLit[0])
    if (ctx.objectLit) return this.visit(ctx.objectLit[0])
    // parenthesised
    return this.visit(ctx.expr[0])
  }

  /**
   * Returns either a plain Literal or a TemplateString. Callers in
   * expression position accept Expr; callers expecting a strict Literal
   * (annotation args, type constraint values) should narrow by `kind`.
   */
  literal(ctx: any): ast.Literal | ast.TemplateString {
    if (ctx.IntLit) {
      const tok = (ctx.IntLit as IToken[])[0]!
      return {
        kind: 'IntLit',
        value: Number.parseInt(tok.image, 10),
        range: tokenRange(tok),
      }
    }
    if (ctx.FloatLit) {
      const tok = (ctx.FloatLit as IToken[])[0]!
      return {
        kind: 'FloatLit',
        value: Number.parseFloat(tok.image),
        range: tokenRange(tok),
      }
    }
    if (ctx.StringLit) {
      const tok = (ctx.StringLit as IToken[])[0]!
      return buildStringExpr(tok)
    }
    if (ctx.True) {
      const tok = (ctx.True as IToken[])[0]!
      return { kind: 'BoolLit', value: true, range: tokenRange(tok) }
    }
    if (ctx.False) {
      const tok = (ctx.False as IToken[])[0]!
      return { kind: 'BoolLit', value: false, range: tokenRange(tok) }
    }
    const tok = (ctx.Null as IToken[])[0]!
    return { kind: 'NullLit', range: tokenRange(tok) }
  }

  arrayLit(ctx: any): ast.ArrayLit {
    const lb = (ctx.LBracket as IToken[])[0]!
    const rb = (ctx.RBracket as IToken[])[0]!
    const elements = ctx.expr
      ? (ctx.expr as CstNode[]).map((c) => this.visit(c) as ast.Expr)
      : []
    return { kind: 'ArrayLit', elements, range: spanTokens(lb, rb) }
  }

  objectLit(ctx: any): ast.ObjectLit {
    const lc = (ctx.LCurly as IToken[])[0]!
    const rc = (ctx.RCurly as IToken[])[0]!
    const fields = ((ctx.objectLitField ?? []) as CstNode[]).map(
      (c) => this.visit(c) as ast.ObjectLitField,
    )
    return { kind: 'ObjectLit', fields, range: spanTokens(lc, rc) }
  }

  objectLitField(ctx: any): ast.ObjectLitField {
    if (ctx.StringLit) {
      const keyTok = (ctx.StringLit as IToken[])[0]!
      const value = this.visit(ctx.expr[0]) as ast.Expr
      return {
        kind: 'ObjectLitField',
        key: unquoteString(keyTok.image),
        shorthand: false,
        value,
        range: spanFromTokenToRange(keyTok, value.range),
      }
    }
    const idTok = (ctx.Identifier as IToken[])[0]!
    if (ctx.expr) {
      const value = this.visit(ctx.expr[0]) as ast.Expr
      return {
        kind: 'ObjectLitField',
        key: idTok.image,
        shorthand: false,
        value,
        range: spanFromTokenToRange(idTok, value.range),
      }
    }
    // shorthand: { x } means { x: x }
    return {
      kind: 'ObjectLitField',
      key: idTok.image,
      shorthand: true,
      value: { kind: 'IdentExpr', name: idTok.image, range: tokenRange(idTok) },
      range: tokenRange(idTok),
    }
  }
}

// ─── Helpers used by visitor ──────────────────────────────────────────

function spanTokens(start: IToken, end: IToken): ast.Range {
  return {
    startLine: start.startLine ?? 0,
    startColumn: start.startColumn ?? 0,
    endLine: end.endLine ?? 0,
    endColumn: end.endColumn ?? 0,
    startOffset: start.startOffset,
    endOffset: end.endOffset ?? end.startOffset,
  }
}

function spanRanges(a: ast.Range, b: ast.Range): ast.Range {
  return {
    startLine: a.startLine,
    startColumn: a.startColumn,
    endLine: b.endLine,
    endColumn: b.endColumn,
    startOffset: a.startOffset,
    endOffset: b.endOffset,
  }
}

function spanFromTokenToRange(start: IToken, end: ast.Range): ast.Range {
  return {
    startLine: start.startLine ?? 0,
    startColumn: start.startColumn ?? 0,
    endLine: end.endLine,
    endColumn: end.endColumn,
    startOffset: start.startOffset,
    endOffset: end.endOffset,
  }
}

function emptyRange(items: ast.AstNode[]): ast.Range {
  if (items.length === 0) {
    return {
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 0,
      startOffset: 0,
      endOffset: 0,
    }
  }
  const first = (items[0] as any).range as ast.Range
  const last = (items[items.length - 1] as any).range as ast.Range
  return spanRanges(first, last)
}

function findFirstToken(node: CstNode): IToken | undefined {
  // CstNode children: { ruleName: CstNode[] | IToken[], ... }
  const children = node.children
  let earliest: IToken | undefined
  for (const key of Object.keys(children)) {
    const arr = children[key]!
    for (const child of arr) {
      let tok: IToken | undefined
      if ('image' in child) {
        tok = child as IToken
      } else {
        tok = findFirstToken(child as CstNode)
      }
      if (tok && (!earliest || tok.startOffset < earliest.startOffset)) {
        earliest = tok
      }
    }
  }
  return earliest
}

/**
 * Build a left-associative binary expression chain from a list of
 * operands and a parallel list of operators. operators[i] joins
 * operands[i] and operands[i+1].
 */
function buildLeftAssocBinary(
  operands: ast.Expr[],
  operators: ast.BinaryOp[],
): ast.Expr {
  let current = operands[0]!
  for (let i = 0; i < operators.length; i++) {
    const right = operands[i + 1]!
    current = {
      kind: 'BinaryExpr',
      op: operators[i]!,
      left: current,
      right,
      range: spanRanges(current.range, right.range),
    }
  }
  return current
}

/**
 * For rules where multiple alternative token names can appear in MANY,
 * gather all operator tokens in source order and map them to AST op strings.
 */
function combineOps(
  ctx: any,
  mapping: ReadonlyArray<readonly [string, ast.BinaryOp]>,
): ast.BinaryOp[] {
  const all: Array<{ offset: number; op: ast.BinaryOp }> = []
  for (const [tokName, op] of mapping) {
    const toks = (ctx[tokName] as IToken[] | undefined) ?? []
    for (const t of toks) all.push({ offset: t.startOffset, op })
  }
  all.sort((a, b) => a.offset - b.offset)
  return all.map((x) => x.op)
}

// ─── Public API ───────────────────────────────────────────────────────

const astBuilder = new TrainAstBuilder()

/**
 * Build a typed AST from a parser CST. Returns null if no CST (parse failed).
 */
export function buildAst(cst: CstNode | undefined): ast.Program | null {
  if (!cst) return null
  return astBuilder.visit(cst) as ast.Program
}
