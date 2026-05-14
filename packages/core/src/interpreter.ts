/**
 * train language interpreter (M2 minimum viable).
 *
 * What this implements:
 *  - All expression forms (literals, template strings, identifiers,
 *    array/object literals, unary, binary with short-circuit, ternary,
 *    member, index, call)
 *  - let/var/const declarations + destructuring binds
 *  - Assignment with all `=` / `+=` / `-=` / `*=` / `/=` / `%=` forms
 *  - if/else-if/else
 *  - for-in (over arrays, strings, object keys)
 *  - while
 *  - break / continue / return (via control-flow signals)
 *  - try-catch with class-name match + optional binding
 *  - func calls with positional args + lexical scoping
 *
 * NOT implemented (stubs throw clearly):
 *  - fai function execution (requires LLMAdapter — M3)
 *  - ask_user (requires host callback — M3)
 *  - import / subflow (M5)
 *  - persistent stack frames (M3 when fai introduces suspend points)
 *
 * Control flow via JS throw/catch:
 *  - return  → TrainReturnSignal
 *  - break   → TrainBreakSignal
 *  - continue → TrainContinueSignal
 *  - user exception → TrainException (caught by try/catch in program)
 */

import * as ast from './ast.js'
import {
  type Value,
  type FunctionValue,
  type Scope,
  type RuntimeContext,
  type BuiltinFunction,
  TrainReturnSignal,
  TrainBreakSignal,
  TrainContinueSignal,
  TrainException,
  InterpreterBug,
  newScope,
  scopeLookup,
  scopeAssign,
  isFunctionValue,
  isBuiltin,
} from './runtime.js'
import { defaultBuiltinBindings, formatValue } from './builtins.js'

export interface RunResult {
  ok: boolean
  value: Value | null
  error?: TrainException
}

export class Interpreter {
  constructor(private ctx: RuntimeContext) {}

  // ─── Expressions ─────────────────────────────────────────────────────

  evalExpr(expr: ast.Expr, scope: Scope): Value {
    switch (expr.kind) {
      case 'IntLit':
      case 'FloatLit':
        return expr.value
      case 'StringLit':
        return expr.value
      case 'BoolLit':
        return expr.value
      case 'NullLit':
        return null
      case 'TemplateString':
        return this.evalTemplate(expr, scope)
      case 'IdentExpr':
        return this.evalIdent(expr, scope)
      case 'ArrayLit':
        return expr.elements.map((e) => this.evalExpr(e, scope))
      case 'ObjectLit': {
        const obj: { [k: string]: Value } = {}
        for (const f of expr.fields) {
          obj[f.key] = this.evalExpr(f.value, scope)
        }
        return obj
      }
      case 'UnaryExpr':
        return this.evalUnary(expr, scope)
      case 'BinaryExpr':
        return this.evalBinary(expr, scope)
      case 'TernaryExpr':
        return this.truthy(this.evalExpr(expr.cond, scope))
          ? this.evalExpr(expr.then, scope)
          : this.evalExpr(expr.otherwise, scope)
      case 'MemberExpr': {
        const o = this.evalExpr(expr.object, scope)
        return this.getMember(o, expr.property, expr.range)
      }
      case 'IndexExpr': {
        const o = this.evalExpr(expr.object, scope)
        const k = this.evalExpr(expr.index, scope)
        return this.getIndex(o, k, expr.range)
      }
      case 'CallExpr':
        return this.evalCall(expr, scope)
    }
  }

  private evalIdent(expr: ast.IdentExpr, scope: Scope): Value {
    // Lookup order: local scope chain → globals → constants → functions → builtins
    const localVal = scopeLookup(scope, expr.name)
    if (localVal !== undefined) return localVal
    if (this.ctx.globals.has(expr.name)) return this.ctx.globals.get(expr.name)!
    if (this.ctx.constants.has(expr.name))
      return this.ctx.constants.get(expr.name)!
    if (this.ctx.functions.has(expr.name))
      return this.ctx.functions.get(expr.name)! as unknown as Value
    if (this.ctx.builtins.has(expr.name))
      return this.ctx.builtins.get(expr.name)! as unknown as Value
    throw new TrainException(
      'RuntimeError',
      `Undefined identifier '${expr.name}'`,
      expr.range,
    )
  }

  private evalTemplate(expr: ast.TemplateString, scope: Scope): string {
    const parts: string[] = []
    for (const p of expr.parts) {
      if (p.kind === 'TemplateChunk') parts.push(p.value)
      else parts.push(formatValue(this.evalExpr(p.expr, scope)))
    }
    return parts.join('')
  }

  private evalUnary(expr: ast.UnaryExpr, scope: Scope): Value {
    const v = this.evalExpr(expr.operand, scope)
    if (expr.op === '-') {
      if (typeof v !== 'number')
        throw new TrainException(
          'RuntimeError',
          `unary '-' expected number, got ${typeName(v)}`,
          expr.range,
        )
      return -v
    }
    return !this.truthy(v)
  }

  private evalBinary(expr: ast.BinaryExpr, scope: Scope): Value {
    // Short-circuit on logical operators
    if (expr.op === '&&') {
      const l = this.evalExpr(expr.left, scope)
      if (!this.truthy(l)) return l
      return this.evalExpr(expr.right, scope)
    }
    if (expr.op === '||') {
      const l = this.evalExpr(expr.left, scope)
      if (this.truthy(l)) return l
      return this.evalExpr(expr.right, scope)
    }

    const l = this.evalExpr(expr.left, scope)
    const r = this.evalExpr(expr.right, scope)
    switch (expr.op) {
      case '+':
        if (typeof l === 'string' || typeof r === 'string')
          return formatValue(l) + formatValue(r)
        if (typeof l === 'number' && typeof r === 'number') return l + r
        throw binTypeErr(expr, l, r)
      case '-':
        return numBin(expr, l, r, (a, b) => a - b)
      case '*':
        return numBin(expr, l, r, (a, b) => a * b)
      case '/':
        if (typeof l === 'number' && typeof r === 'number') {
          if (r === 0)
            throw new TrainException('RuntimeError', 'division by zero', expr.range)
          return l / r
        }
        throw binTypeErr(expr, l, r)
      case '%':
        if (typeof l === 'number' && typeof r === 'number') {
          if (r === 0)
            throw new TrainException(
              'RuntimeError',
              'modulo by zero',
              expr.range,
            )
          return l % r
        }
        throw binTypeErr(expr, l, r)
      case '==':
        return deepEqValue(l, r)
      case '!=':
        return !deepEqValue(l, r)
      case '<':
        return cmp(expr, l, r) < 0
      case '<=':
        return cmp(expr, l, r) <= 0
      case '>':
        return cmp(expr, l, r) > 0
      case '>=':
        return cmp(expr, l, r) >= 0
    }
    throw new InterpreterBug(`unhandled binary op: ${expr.op}`)
  }

  private getMember(obj: Value, prop: string, range?: ast.Range): Value {
    if (obj === null)
      throw new TrainException(
        'RuntimeError',
        `cannot read property '${prop}' of null`,
        range,
      )
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      // Plain object or function-like / log namespace
      const o = obj as { [k: string]: Value }
      if (prop in o) return o[prop]!
      // For function/builtin values, no fields accessible
      throw new TrainException(
        'RuntimeError',
        `unknown property '${prop}'`,
        range,
      )
    }
    if (Array.isArray(obj)) {
      if (prop === 'length') return obj.length
    }
    if (typeof obj === 'string') {
      if (prop === 'length') return [...obj].length
    }
    throw new TrainException(
      'RuntimeError',
      `cannot read property '${prop}' on ${typeName(obj)}`,
      range,
    )
  }

  private getIndex(obj: Value, key: Value, range?: ast.Range): Value {
    if (Array.isArray(obj)) {
      if (typeof key !== 'number')
        throw new TrainException(
          'RuntimeError',
          `array index must be a number, got ${typeName(key)}`,
          range,
        )
      const i = key < 0 ? obj.length + key : key
      if (i < 0 || i >= obj.length) return null
      return obj[i]!
    }
    if (typeof obj === 'string') {
      if (typeof key !== 'number')
        throw new TrainException(
          'RuntimeError',
          `string index must be a number, got ${typeName(key)}`,
          range,
        )
      const codepoints = [...obj]
      const i = key < 0 ? codepoints.length + key : key
      if (i < 0 || i >= codepoints.length) return null
      return codepoints[i]!
    }
    if (obj !== null && typeof obj === 'object') {
      if (typeof key !== 'string')
        throw new TrainException(
          'RuntimeError',
          `object key must be a string, got ${typeName(key)}`,
          range,
        )
      const o = obj as { [k: string]: Value }
      return key in o ? o[key]! : null
    }
    throw new TrainException(
      'RuntimeError',
      `cannot index ${typeName(obj)}`,
      range,
    )
  }

  private evalCall(expr: ast.CallExpr, scope: Scope): Value {
    const callee = this.evalExpr(expr.callee, scope)
    const args = expr.args.map((a) => this.evalExpr(a, scope))
    if (isFunctionValue(callee)) {
      if (callee.isFai) {
        // M2 stub: real implementation comes with the LLM adapter in M3.
        throw new TrainException(
          'RuntimeError',
          `fai function '${callee.name}' is not yet executable (no LLM adapter installed)`,
          expr.range,
        )
      }
      return this.callFunc(callee, args, expr.range)
    }
    if (isBuiltin(callee as unknown as Value)) {
      const b = callee as unknown as BuiltinFunction
      return b.call(args)
    }
    throw new TrainException(
      'RuntimeError',
      `value is not callable: ${typeName(callee)}`,
      expr.range,
    )
  }

  callFunc(
    fn: FunctionValue,
    args: Value[],
    range?: ast.Range,
  ): Value {
    if (fn.decl.kind !== 'FuncDecl')
      throw new InterpreterBug('callFunc dispatched on non-func decl')
    const decl = fn.decl as ast.FuncDecl
    if (args.length !== decl.params.length) {
      throw new TrainException(
        'RuntimeError',
        `${fn.name}() expects ${decl.params.length} arg(s), got ${args.length}`,
        range,
      )
    }
    const callScope = newScope(fn.definedIn)
    decl.params.forEach((p, i) => callScope.bindings.set(p.name, args[i]!))
    try {
      this.execBlock(decl.body, callScope)
    } catch (e) {
      if (e instanceof TrainReturnSignal) return e.value ?? null
      throw e
    }
    return null
  }

  // ─── Statements / blocks ─────────────────────────────────────────────

  execBlock(block: ast.Block, scope: Scope) {
    const inner = newScope(scope)
    for (const s of block.stmts) this.execStmt(s, inner)
  }

  execStmt(stmt: ast.Stmt, scope: Scope) {
    switch (stmt.kind) {
      case 'LetDecl':
        return this.execLet(stmt, scope)
      case 'Assignment':
        return this.execAssign(stmt, scope)
      case 'IfStmt':
        return this.execIf(stmt, scope)
      case 'ForStmt':
        return this.execFor(stmt, scope)
      case 'WhileStmt':
        return this.execWhile(stmt, scope)
      case 'TryStmt':
        return this.execTry(stmt, scope)
      case 'BreakStmt':
        throw new TrainBreakSignal()
      case 'ContinueStmt':
        throw new TrainContinueSignal()
      case 'ReturnStmt':
        throw new TrainReturnSignal(
          stmt.value ? this.evalExpr(stmt.value, scope) : null,
        )
      case 'ExprStmt':
        this.evalExpr(stmt.expr, scope)
        return
    }
  }

  private execLet(stmt: ast.LetDecl, scope: Scope) {
    const v = stmt.init ? this.evalExpr(stmt.init, scope) : null
    this.bindLetTarget(stmt.target, v, scope, stmt.range)
  }

  private bindLetTarget(
    target: ast.LetTarget,
    v: Value,
    scope: Scope,
    range: ast.Range,
  ) {
    if (target.kind === 'IdentTarget') {
      scope.bindings.set(target.name, v)
      return
    }
    if (target.kind === 'ObjectDestruct') {
      if (
        v === null ||
        typeof v !== 'object' ||
        Array.isArray(v) ||
        isFunctionValue(v) ||
        isBuiltin(v as unknown as Value)
      ) {
        throw new TrainException(
          'RuntimeError',
          `cannot object-destructure ${typeName(v)}`,
          range,
        )
      }
      const o = v as { [k: string]: Value }
      for (const f of target.fields) {
        scope.bindings.set(f.local, f.source in o ? o[f.source]! : null)
      }
      return
    }
    // ArrayDestruct
    if (!Array.isArray(v)) {
      throw new TrainException(
        'RuntimeError',
        `cannot array-destructure ${typeName(v)}`,
        range,
      )
    }
    for (let i = 0; i < target.names.length; i++) {
      scope.bindings.set(target.names[i]!, i < v.length ? v[i]! : null)
    }
  }

  private execAssign(stmt: ast.Assignment, scope: Scope) {
    const rhs = this.evalExpr(stmt.value, scope)
    const baseName = stmt.target.base

    if (stmt.target.suffixes.length === 0) {
      // simple variable assignment
      const current =
        scopeLookup(scope, baseName) ??
        (this.ctx.globals.has(baseName)
          ? this.ctx.globals.get(baseName)!
          : undefined)
      const newVal = stmt.op === '=' ? rhs : this.applyCompound(stmt.op, current, rhs, stmt.range)
      if (scopeAssign(scope, baseName, newVal)) return
      if (this.ctx.globals.has(baseName)) {
        this.ctx.globals.set(baseName, newVal)
        return
      }
      if (this.ctx.constants.has(baseName))
        throw new TrainException(
          'RuntimeError',
          `cannot reassign const '${baseName}'`,
          stmt.range,
        )
      throw new TrainException(
        'RuntimeError',
        `assignment to undeclared variable '${baseName}'`,
        stmt.range,
      )
    }

    // Suffix chain: walk to penultimate, then set last
    let cursor: Value =
      scopeLookup(scope, baseName) ??
      this.ctx.globals.get(baseName) ??
      this.ctx.constants.get(baseName)!
    if (cursor === undefined) {
      throw new TrainException(
        'RuntimeError',
        `undefined identifier '${baseName}'`,
        stmt.range,
      )
    }
    for (let i = 0; i < stmt.target.suffixes.length - 1; i++) {
      cursor = this.followSuffix(cursor, stmt.target.suffixes[i]!, scope)
    }
    const lastSuf = stmt.target.suffixes[stmt.target.suffixes.length - 1]!
    const oldValue = this.followSuffix(cursor, lastSuf, scope)
    const newVal =
      stmt.op === '=' ? rhs : this.applyCompound(stmt.op, oldValue, rhs, stmt.range)
    this.setSuffix(cursor, lastSuf, newVal, scope, stmt.range)
  }

  private followSuffix(obj: Value, suf: ast.LValueSuffix, scope: Scope): Value {
    if (suf.kind === 'MemberSuffix') return this.getMember(obj, suf.name)
    return this.getIndex(obj, this.evalExpr(suf.index, scope))
  }

  private setSuffix(
    obj: Value,
    suf: ast.LValueSuffix,
    val: Value,
    scope: Scope,
    range: ast.Range,
  ) {
    if (suf.kind === 'MemberSuffix') {
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
        throw new TrainException(
          'RuntimeError',
          `cannot set property '${suf.name}' on ${typeName(obj)}`,
          range,
        )
      ;(obj as { [k: string]: Value })[suf.name] = val
      return
    }
    const key = this.evalExpr(suf.index, scope)
    if (Array.isArray(obj)) {
      if (typeof key !== 'number')
        throw new TrainException(
          'RuntimeError',
          `array index must be a number, got ${typeName(key)}`,
          range,
        )
      const i = key < 0 ? obj.length + key : key
      obj[i] = val
      return
    }
    if (obj !== null && typeof obj === 'object') {
      if (typeof key !== 'string')
        throw new TrainException(
          'RuntimeError',
          `object key must be a string`,
          range,
        )
      ;(obj as { [k: string]: Value })[key] = val
      return
    }
    throw new TrainException(
      'RuntimeError',
      `cannot index-assign ${typeName(obj)}`,
      range,
    )
  }

  private applyCompound(
    op: ast.AssignOp,
    old: Value | undefined,
    rhs: Value,
    range: ast.Range,
  ): Value {
    if (old === undefined)
      throw new TrainException(
        'RuntimeError',
        `compound assignment ${op} on undeclared variable`,
        range,
      )
    if (typeof old !== 'number' || typeof rhs !== 'number') {
      if (op === '+=' && (typeof old === 'string' || typeof rhs === 'string')) {
        return formatValue(old) + formatValue(rhs)
      }
      throw new TrainException(
        'RuntimeError',
        `${op} requires numbers, got ${typeName(old)} and ${typeName(rhs)}`,
        range,
      )
    }
    switch (op) {
      case '+=':
        return old + rhs
      case '-=':
        return old - rhs
      case '*=':
        return old * rhs
      case '/=':
        if (rhs === 0)
          throw new TrainException('RuntimeError', 'division by zero', range)
        return old / rhs
      case '%=':
        if (rhs === 0)
          throw new TrainException('RuntimeError', 'modulo by zero', range)
        return old % rhs
      case '=':
        return rhs
    }
  }

  private execIf(stmt: ast.IfStmt, scope: Scope) {
    if (this.truthy(this.evalExpr(stmt.cond, scope))) {
      return this.execBlock(stmt.then, scope)
    }
    for (const elif of stmt.elifs) {
      if (this.truthy(this.evalExpr(elif.cond, scope))) {
        return this.execBlock(elif.body, scope)
      }
    }
    if (stmt.otherwise) this.execBlock(stmt.otherwise, scope)
  }

  private execFor(stmt: ast.ForStmt, scope: Scope) {
    const iter = this.evalExpr(stmt.iterable, scope)
    const items = this.iterable(iter, stmt.range)
    for (const item of items) {
      const inner = newScope(scope)
      inner.bindings.set(stmt.binding, item)
      try {
        this.execBlock(stmt.body, inner)
      } catch (e) {
        if (e instanceof TrainBreakSignal) return
        if (e instanceof TrainContinueSignal) continue
        throw e
      }
    }
  }

  private iterable(v: Value, range: ast.Range): Value[] {
    if (Array.isArray(v)) return v
    if (typeof v === 'string') return [...v]
    if (v !== null && typeof v === 'object' && !isFunctionValue(v) && !isBuiltin(v as unknown as Value)) {
      return Object.keys(v as { [k: string]: Value })
    }
    throw new TrainException(
      'RuntimeError',
      `cannot iterate ${typeName(v)}`,
      range,
    )
  }

  private execWhile(stmt: ast.WhileStmt, scope: Scope) {
    while (this.truthy(this.evalExpr(stmt.cond, scope))) {
      try {
        this.execBlock(stmt.body, scope)
      } catch (e) {
        if (e instanceof TrainBreakSignal) return
        if (e instanceof TrainContinueSignal) continue
        throw e
      }
    }
  }

  private execTry(stmt: ast.TryStmt, scope: Scope) {
    try {
      this.execBlock(stmt.body, scope)
    } catch (e) {
      if (e instanceof TrainException) {
        for (const c of stmt.catches) {
          if (c.errorType === e.errorType) {
            const inner = newScope(scope)
            if (c.binding) {
              // Bind the exception as a structured object
              inner.bindings.set(c.binding, {
                type: e.errorType,
                message: e.message,
              })
            }
            this.execBlock(c.body, inner)
            return
          }
        }
      }
      // not caught — propagate
      throw e
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private truthy(v: Value): boolean {
    if (v === null) return false
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') return v.length > 0
    if (Array.isArray(v)) return v.length > 0
    return true
  }
}

// ─── Top-level program runner ─────────────────────────────────────────

export interface RunOptions {
  /** Name of the entry export to call. Default: "main". */
  entry?: string
  /** Positional arguments passed to the entry function. */
  args?: Value[]
  /** Additional builtins to merge atop the defaults. */
  extraBuiltins?: Map<string, Value>
}

export function runProgram(program: ast.Program, opts: RunOptions = {}): RunResult {
  const ctx: RuntimeContext = {
    constants: new Map(),
    globals: new Map(),
    functions: new Map(),
    builtins: new Map(),
    exports: new Map(),
  }
  // Built-ins
  for (const [k, v] of defaultBuiltinBindings()) {
    ctx.builtins.set(k, v as unknown as BuiltinFunction)
  }
  if (opts.extraBuiltins) {
    for (const [k, v] of opts.extraBuiltins) {
      ctx.builtins.set(k, v as unknown as BuiltinFunction)
    }
  }

  const interp = new Interpreter(ctx)
  const rootScope = newScope(null)

  // 1st pass: register function declarations (so they can be called
  // before their textual position, like C/Python module scope).
  for (const item of program.items) {
    registerTopLevelFunctions(item, ctx, rootScope)
  }

  // 2nd pass: evaluate top-level const/var initializers; handle exports.
  try {
    for (const item of program.items) {
      evalTopLevelItem(item, interp, ctx, rootScope)
    }
  } catch (e) {
    if (e instanceof TrainException) return { ok: false, value: null, error: e }
    throw e
  }

  // 3rd: find entry export and call it
  const entryName = opts.entry ?? 'main'
  const internalName = ctx.exports.get(entryName)
  if (!internalName) {
    return {
      ok: false,
      value: null,
      error: new TrainException(
        'RuntimeError',
        `no export named '${entryName}' found`,
      ),
    }
  }
  const fn = ctx.functions.get(internalName)
  if (!fn) {
    return {
      ok: false,
      value: null,
      error: new TrainException(
        'RuntimeError',
        `export '${entryName}' is not a function`,
      ),
    }
  }
  try {
    if (fn.isFai) {
      return {
        ok: false,
        value: null,
        error: new TrainException(
          'RuntimeError',
          `entry function '${entryName}' is a fai; cannot run without an LLM adapter`,
        ),
      }
    }
    const value = interp.callFunc(fn, opts.args ?? [])
    return { ok: true, value }
  } catch (e) {
    if (e instanceof TrainException) return { ok: false, value: null, error: e }
    throw e
  }
}

function registerTopLevelFunctions(
  item: ast.TopLevel,
  ctx: RuntimeContext,
  rootScope: Scope,
) {
  if (item.kind === 'FuncDecl' || item.kind === 'FaiDecl') {
    ctx.functions.set(item.name, {
      __kind: 'function',
      name: item.name,
      isFai: item.kind === 'FaiDecl',
      decl: item,
      definedIn: rootScope,
    })
    return
  }
  if (item.kind === 'ExportDecl') {
    const tgt = item.target
    if (tgt.kind === 'FuncDecl' || tgt.kind === 'FaiDecl') {
      ctx.functions.set(tgt.name, {
        __kind: 'function',
        name: tgt.name,
        isFai: tgt.kind === 'FaiDecl',
        decl: tgt,
        definedIn: rootScope,
      })
    }
  }
}

function evalTopLevelItem(
  item: ast.TopLevel,
  interp: Interpreter,
  ctx: RuntimeContext,
  rootScope: Scope,
) {
  switch (item.kind) {
    case 'Import':
      // M2: imports are no-ops. M5 will load + execute external modules.
      return
    case 'RuntimeAnnotation':
      // Runtime config (adapter selection etc.) is irrelevant for the
      // pure-compute subset; future milestones will read it.
      return
    case 'ConstDecl':
      ctx.constants.set(item.name, interp.evalExpr(item.value, rootScope))
      return
    case 'VarDecl':
      ctx.globals.set(
        item.name,
        item.init ? interp.evalExpr(item.init, rootScope) : null,
      )
      return
    case 'FuncDecl':
    case 'FaiDecl':
      // already registered in 1st pass
      return
    case 'ExportDecl':
      registerExports(item, ctx)
      return
  }
}

function registerExports(decl: ast.ExportDecl, ctx: RuntimeContext) {
  const tgt = decl.target
  if (tgt.kind === 'ExportNames') {
    for (const spec of tgt.specs) {
      const exported = spec.alias ?? spec.name
      ctx.exports.set(exported, spec.name)
    }
    return
  }
  // `export func foo() {…}` / `export fai foo(…) -> … {…}`
  ctx.exports.set(tgt.name, tgt.name)
}

// ─── Local helpers shared across module ───────────────────────────────

function typeName(v: Value): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (isFunctionValue(v) || isBuiltin(v as unknown as Value)) return 'function'
  return typeof v
}

function numBin(
  expr: ast.BinaryExpr,
  l: Value,
  r: Value,
  fn: (a: number, b: number) => number,
): number {
  if (typeof l === 'number' && typeof r === 'number') return fn(l, r)
  throw binTypeErr(expr, l, r)
}

function cmp(expr: ast.BinaryExpr, l: Value, r: Value): number {
  if (typeof l === 'number' && typeof r === 'number') {
    return l < r ? -1 : l > r ? 1 : 0
  }
  if (typeof l === 'string' && typeof r === 'string') {
    return l < r ? -1 : l > r ? 1 : 0
  }
  throw binTypeErr(expr, l, r)
}

function binTypeErr(
  expr: ast.BinaryExpr,
  l: Value,
  r: Value,
): TrainException {
  return new TrainException(
    'RuntimeError',
    `operator '${expr.op}' undefined for ${typeName(l)} and ${typeName(r)}`,
    expr.range,
  )
}

function deepEqValue(a: Value, b: Value): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqValue(a[i]!, b[i]!)) return false
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
      if (!deepEqValue(ao[k]!, bo[k]!)) return false
    }
    return true
  }
  return false
}
