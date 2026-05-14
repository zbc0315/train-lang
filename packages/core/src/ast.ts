/**
 * Typed Abstract Syntax Tree for train language.
 *
 * The AST is what later stages (type checker, interpreter, formatter)
 * consume. It is produced from the CST by the visitor in `builder.ts`.
 *
 * Design choices:
 * - Every node has a `kind` discriminator (TypeScript narrowing)
 * - Every node has a `range` carrying source location for diagnostics
 * - Numeric / string / bool literals are pre-parsed to their JS values
 * - String escape sequences are unescaped
 * - All node names are PascalCase nominal types
 */

// ─── Source range ─────────────────────────────────────────────────────

export interface Range {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  startOffset: number
  endOffset: number
}

interface Located {
  range: Range
}

// ─── Program ──────────────────────────────────────────────────────────

export interface Program extends Located {
  kind: 'Program'
  items: TopLevel[]
}

export type TopLevel =
  | Import
  | RuntimeAnnotation
  | ConstDecl
  | VarDecl
  | FuncDecl
  | FaiDecl
  | ExportDecl

// ─── Imports / Exports ────────────────────────────────────────────────

export interface Import extends Located {
  kind: 'Import'
  clause: NamedImports | NamespaceImport
  source: string // unquoted module path
  version: string | null // "@abc1234" -> "abc1234"; null if absent
}

export interface NamedImports extends Located {
  kind: 'NamedImports'
  specs: ImportSpec[]
}

export interface ImportSpec extends Located {
  kind: 'ImportSpec'
  name: string
  alias: string | null
}

export interface NamespaceImport extends Located {
  kind: 'NamespaceImport'
  alias: string
}

export interface ExportDecl extends Located {
  kind: 'ExportDecl'
  target: ExportNames | FuncDecl | FaiDecl
}

export interface ExportNames extends Located {
  kind: 'ExportNames'
  specs: ExportSpec[]
}

export interface ExportSpec extends Located {
  kind: 'ExportSpec'
  name: string
  alias: string | null
}

// ─── Annotations ──────────────────────────────────────────────────────

export interface RuntimeAnnotation extends Located {
  kind: 'RuntimeAnnotation'
  name: string // "@runtime" -> "runtime"
  args: AnnotationArg[]
}

export interface Annotation extends Located {
  kind: 'Annotation'
  name: string // "@cache" -> "cache"
  args: AnnotationArg[]
}

export interface AnnotationArg extends Located {
  kind: 'AnnotationArg'
  key: string | null // null = positional
  // Type-checker enforces this is a plain Literal; the AST allows
  // TemplateString here for diagnostic friendliness.
  value: Literal | TemplateString
}

// ─── Top-level declarations ───────────────────────────────────────────

export interface ConstDecl extends Located {
  kind: 'ConstDecl'
  name: string
  type: TypeAnnot
  value: Expr
}

export interface VarDecl extends Located {
  kind: 'VarDecl'
  name: string
  type: TypeAnnot
  init: Expr | null
}

export interface FuncDecl extends Located {
  kind: 'FuncDecl'
  annotations: Annotation[]
  name: string
  params: Param[]
  returnType: TypeAnnot | null
  body: Block
}

export interface FaiDecl extends Located {
  kind: 'FaiDecl'
  annotations: Annotation[]
  name: string
  params: FaiParam[]
  outputs: FaiOutput[]
  body: Block
}

// ─── Parameters / Outputs ─────────────────────────────────────────────

export interface Param extends Located {
  kind: 'Param'
  name: string
  type: TypeAnnot | null
}

export interface FaiParam extends Located {
  kind: 'FaiParam'
  name: string
  type: TypeAnnot
}

export interface FaiOutput extends Located {
  kind: 'FaiOutput'
  name: string
  type: TypeAnnot
}

// ─── Types ────────────────────────────────────────────────────────────

export type TypeAnnot = ScalarType | EnumType | ArrayType | ObjectType

export interface ScalarType extends Located {
  kind: 'ScalarType'
  name: string // int / float / bool / string / prompt / any / etc.
  constraint: TypeConstraint | null
}

export type TypeConstraint = RangeConstraint | NamedConstraint

export interface RangeConstraint extends Located {
  kind: 'RangeConstraint'
  min: number
  max: number
}

export interface NamedConstraint extends Located {
  kind: 'NamedConstraint'
  key: string
  value: number | string
}

export interface EnumType extends Located {
  kind: 'EnumType'
  variants: string[]
}

export interface ArrayType extends Located {
  kind: 'ArrayType'
  element: TypeAnnot
  constraint: NamedConstraint | null
}

export interface ObjectType extends Located {
  kind: 'ObjectType'
  fields: ObjectTypeField[]
}

export interface ObjectTypeField extends Located {
  kind: 'ObjectTypeField'
  name: string
  type: TypeAnnot
}

// ─── Statements / Block ───────────────────────────────────────────────

export interface Block extends Located {
  kind: 'Block'
  stmts: Stmt[]
}

export type Stmt =
  | LetDecl
  | Assignment
  | IfStmt
  | ForStmt
  | WhileStmt
  | TryStmt
  | BreakStmt
  | ContinueStmt
  | ReturnStmt
  | ExprStmt

export interface LetDecl extends Located {
  kind: 'LetDecl'
  target: LetTarget
  type: TypeAnnot | null
  init: Expr | null
}

export type LetTarget = IdentTarget | ObjectDestruct | ArrayDestruct

export interface IdentTarget extends Located {
  kind: 'IdentTarget'
  name: string
}

export interface ObjectDestruct extends Located {
  kind: 'ObjectDestruct'
  fields: DestructField[]
}

export interface DestructField extends Located {
  kind: 'DestructField'
  source: string // property name on the destructured object
  local: string // local binding name (== source when no rename)
}

export interface ArrayDestruct extends Located {
  kind: 'ArrayDestruct'
  names: string[]
}

export interface Assignment extends Located {
  kind: 'Assignment'
  target: LValue
  op: AssignOp
  value: Expr
}

export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%='

export interface LValue extends Located {
  kind: 'LValue'
  base: string
  suffixes: LValueSuffix[]
}

export type LValueSuffix = MemberSuffix | IndexSuffix

export interface MemberSuffix extends Located {
  kind: 'MemberSuffix'
  name: string
}

export interface IndexSuffix extends Located {
  kind: 'IndexSuffix'
  index: Expr
}

export interface IfStmt extends Located {
  kind: 'IfStmt'
  cond: Expr
  then: Block
  elifs: ElseIf[]
  otherwise: Block | null
}

export interface ElseIf extends Located {
  kind: 'ElseIf'
  cond: Expr
  body: Block
}

export interface ForStmt extends Located {
  kind: 'ForStmt'
  binding: string
  iterable: Expr
  body: Block
}

export interface WhileStmt extends Located {
  kind: 'WhileStmt'
  cond: Expr
  body: Block
}

export interface TryStmt extends Located {
  kind: 'TryStmt'
  body: Block
  catches: CatchClause[]
}

export interface CatchClause extends Located {
  kind: 'CatchClause'
  errorType: string
  binding: string | null
  body: Block
}

export interface BreakStmt extends Located {
  kind: 'BreakStmt'
}

export interface ContinueStmt extends Located {
  kind: 'ContinueStmt'
}

export interface ReturnStmt extends Located {
  kind: 'ReturnStmt'
  value: Expr | null
}

export interface ExprStmt extends Located {
  kind: 'ExprStmt'
  expr: Expr
}

// ─── Expressions ──────────────────────────────────────────────────────

export type Expr =
  | Literal
  | TemplateString
  | IdentExpr
  | ArrayLit
  | ObjectLit
  | UnaryExpr
  | BinaryExpr
  | TernaryExpr
  | MemberExpr
  | IndexExpr
  | CallExpr

export type Literal = IntLit | FloatLit | StringLit | BoolLit | NullLit

export interface IntLit extends Located {
  kind: 'IntLit'
  value: number
}

export interface FloatLit extends Located {
  kind: 'FloatLit'
  value: number
}

export interface StringLit extends Located {
  kind: 'StringLit'
  value: string // unescaped, unquoted
}

export interface BoolLit extends Located {
  kind: 'BoolLit'
  value: boolean
}

export interface NullLit extends Located {
  kind: 'NullLit'
}

/**
 * A double-quoted string that contains one or more `${expr}` interpolations.
 * `parts` is a sequence of literal chunks (already unescaped) and expressions
 * in source order. Always begins and ends with a TemplateChunk (possibly empty).
 *
 * Limit (MVP): expressions inside `${...}` MUST NOT contain string literals.
 * The lexer treats the entire `"..."` as a single token and cannot handle
 * nested quotes. A real implementation would use lexer modes.
 */
export interface TemplateString extends Located {
  kind: 'TemplateString'
  parts: TemplatePart[]
}

export type TemplatePart = TemplateChunk | TemplateExpr

export interface TemplateChunk extends Located {
  kind: 'TemplateChunk'
  value: string // already unescaped
}

export interface TemplateExpr extends Located {
  kind: 'TemplateExpr'
  expr: Expr
}

export interface IdentExpr extends Located {
  kind: 'IdentExpr'
  name: string
}

export interface ArrayLit extends Located {
  kind: 'ArrayLit'
  elements: Expr[]
}

export interface ObjectLit extends Located {
  kind: 'ObjectLit'
  fields: ObjectLitField[]
}

export interface ObjectLitField extends Located {
  kind: 'ObjectLitField'
  key: string // identifier or string literal (literal handled here, not computed)
  shorthand: boolean
  value: Expr // for shorthand, value is IdentExpr with name===key
}

export type UnaryOp = '-' | '!'

export interface UnaryExpr extends Located {
  kind: 'UnaryExpr'
  op: UnaryOp
  operand: Expr
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'

export interface BinaryExpr extends Located {
  kind: 'BinaryExpr'
  op: BinaryOp
  left: Expr
  right: Expr
}

export interface TernaryExpr extends Located {
  kind: 'TernaryExpr'
  cond: Expr
  then: Expr
  otherwise: Expr
}

export interface MemberExpr extends Located {
  kind: 'MemberExpr'
  object: Expr
  property: string
}

export interface IndexExpr extends Located {
  kind: 'IndexExpr'
  object: Expr
  index: Expr
}

export interface CallExpr extends Located {
  kind: 'CallExpr'
  callee: Expr
  args: Expr[]
}

// ─── Convenience: union of all AST nodes ──────────────────────────────

export type AstNode =
  | Program
  | TopLevel
  | NamedImports
  | NamespaceImport
  | ImportSpec
  | ExportNames
  | ExportSpec
  | Annotation
  | AnnotationArg
  | Param
  | FaiParam
  | FaiOutput
  | TypeAnnot
  | TypeConstraint
  | ObjectTypeField
  | Block
  | Stmt
  | LetTarget
  | DestructField
  | LValue
  | LValueSuffix
  | ElseIf
  | CatchClause
  | Expr
  | ObjectLitField
  | TemplatePart
