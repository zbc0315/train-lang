/**
 * AST builder tests.
 *
 * Verifies that:
 *  1. parseToAst returns a Program with expected top-level shape
 *  2. Specific constructs build the right AST node types
 *  3. Every valid fixture in the corpus visits without throwing
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseToAst } from '../src/index.js'
import type * as ast from '../src/ast.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function parseValid(src: string): ast.Program {
  const r = parseToAst(src)
  expect(r.lexErrors).toEqual([])
  expect(r.parseErrors).toEqual([])
  expect(r.ast).not.toBeNull()
  return r.ast!
}

describe('AST smoke — hello.tr style program', () => {
  const SOURCE = `
fai greet(name: string, prompt: prompt) -> message: string maxLen=200 { }

func main(name: string) -> string {
  let r = greet(name, "请用礼貌的方式问候")
  return r.message
}

export main
`

  it('produces a Program with 3 top-level items', () => {
    const program = parseValid(SOURCE)
    expect(program.kind).toBe('Program')
    expect(program.items).toHaveLength(3)
  })

  it('first item is fai decl with expected signature', () => {
    const program = parseValid(SOURCE)
    const fai = program.items[0] as ast.FaiDecl
    expect(fai.kind).toBe('FaiDecl')
    expect(fai.name).toBe('greet')
    expect(fai.params).toHaveLength(2)
    expect(fai.params[0]!.name).toBe('name')
    expect(fai.params[0]!.type.kind).toBe('ScalarType')
    expect((fai.params[0]!.type as ast.ScalarType).name).toBe('string')
    expect(fai.params[1]!.name).toBe('prompt')
    expect((fai.params[1]!.type as ast.ScalarType).name).toBe('prompt')

    expect(fai.outputs).toHaveLength(1)
    expect(fai.outputs[0]!.name).toBe('message')
    const outType = fai.outputs[0]!.type as ast.ScalarType
    expect(outType.name).toBe('string')
    expect(outType.constraint?.kind).toBe('NamedConstraint')
    expect((outType.constraint as ast.NamedConstraint).key).toBe('maxLen')
    expect((outType.constraint as ast.NamedConstraint).value).toBe(200)
  })

  it('second item is func decl with let + return', () => {
    const program = parseValid(SOURCE)
    const fn = program.items[1] as ast.FuncDecl
    expect(fn.kind).toBe('FuncDecl')
    expect(fn.name).toBe('main')
    expect(fn.body.stmts).toHaveLength(2)
    const letStmt = fn.body.stmts[0] as ast.LetDecl
    expect(letStmt.kind).toBe('LetDecl')
    expect((letStmt.target as ast.IdentTarget).name).toBe('r')
    expect(letStmt.init?.kind).toBe('CallExpr')
    const ret = fn.body.stmts[1] as ast.ReturnStmt
    expect(ret.kind).toBe('ReturnStmt')
    expect(ret.value?.kind).toBe('MemberExpr')
  })

  it('third item is export main', () => {
    const program = parseValid(SOURCE)
    const exp = program.items[2] as ast.ExportDecl
    expect(exp.kind).toBe('ExportDecl')
    const target = exp.target as ast.ExportNames
    expect(target.kind).toBe('ExportNames')
    expect(target.specs).toHaveLength(1)
    expect(target.specs[0]!.name).toBe('main')
    expect(target.specs[0]!.alias).toBeNull()
  })
})

describe('AST: literals', () => {
  it('int / float / string / bool / null literals', () => {
    const p = parseValid(`
      func t() {
        let a = 42
        let b = 3.14
        let c = "hi"
        let d = true
        let e = false
        let f = null
      }
      export t
    `)
    const fn = p.items[0] as ast.FuncDecl
    const stmts = fn.body.stmts as ast.LetDecl[]
    expect((stmts[0]!.init as ast.IntLit).value).toBe(42)
    expect((stmts[0]!.init as ast.IntLit).kind).toBe('IntLit')
    expect((stmts[1]!.init as ast.FloatLit).value).toBeCloseTo(3.14)
    expect((stmts[1]!.init as ast.FloatLit).kind).toBe('FloatLit')
    expect((stmts[2]!.init as ast.StringLit).value).toBe('hi')
    expect((stmts[3]!.init as ast.BoolLit).value).toBe(true)
    expect((stmts[4]!.init as ast.BoolLit).value).toBe(false)
    expect((stmts[5]!.init as ast.NullLit).kind).toBe('NullLit')
  })

  it('string escapes are unquoted and unescaped', () => {
    const p = parseValid(`
      func t() {
        let s = "a\\nb\\tc"
      }
      export t
    `)
    const fn = p.items[0] as ast.FuncDecl
    const lit = (fn.body.stmts[0] as ast.LetDecl).init as ast.StringLit
    expect(lit.value).toBe('a\nb\tc')
  })
})

describe('AST: expression precedence', () => {
  it('a + b * c parses as a + (b * c)', () => {
    const p = parseValid(`func t() { let r = a + b * c } export t`)
    const fn = p.items[0] as ast.FuncDecl
    const expr = (fn.body.stmts[0] as ast.LetDecl).init as ast.BinaryExpr
    expect(expr.kind).toBe('BinaryExpr')
    expect(expr.op).toBe('+')
    expect((expr.left as ast.IdentExpr).name).toBe('a')
    const right = expr.right as ast.BinaryExpr
    expect(right.kind).toBe('BinaryExpr')
    expect(right.op).toBe('*')
  })

  it('a < b && c > d || !e parses correctly', () => {
    const p = parseValid(`func t() { let r = a < b && c > d || !e } export t`)
    const fn = p.items[0] as ast.FuncDecl
    const expr = (fn.body.stmts[0] as ast.LetDecl).init as ast.BinaryExpr
    expect(expr.op).toBe('||')
    const left = expr.left as ast.BinaryExpr
    expect(left.op).toBe('&&')
    const right = expr.right as ast.UnaryExpr
    expect(right.kind).toBe('UnaryExpr')
    expect(right.op).toBe('!')
  })

  it('ternary builds TernaryExpr', () => {
    const p = parseValid(`func t() { let r = a > 0 ? "pos" : "neg" } export t`)
    const fn = p.items[0] as ast.FuncDecl
    const expr = (fn.body.stmts[0] as ast.LetDecl).init as ast.TernaryExpr
    expect(expr.kind).toBe('TernaryExpr')
    expect((expr.then as ast.StringLit).value).toBe('pos')
    expect((expr.otherwise as ast.StringLit).value).toBe('neg')
  })
})

describe('AST: postfix chains', () => {
  it('a.b.c becomes nested MemberExpr', () => {
    const p = parseValid(`func t() { let r = a.b.c } export t`)
    const fn = p.items[0] as ast.FuncDecl
    const expr = (fn.body.stmts[0] as ast.LetDecl).init as ast.MemberExpr
    expect(expr.kind).toBe('MemberExpr')
    expect(expr.property).toBe('c')
    const inner = expr.object as ast.MemberExpr
    expect(inner.property).toBe('b')
    expect((inner.object as ast.IdentExpr).name).toBe('a')
  })

  it('f(1, 2).x[0] mixes call/member/index', () => {
    const p = parseValid(`func t() { let r = f(1, 2).x[0] } export t`)
    const fn = p.items[0] as ast.FuncDecl
    const idx = (fn.body.stmts[0] as ast.LetDecl).init as ast.IndexExpr
    expect(idx.kind).toBe('IndexExpr')
    const mem = idx.object as ast.MemberExpr
    expect(mem.kind).toBe('MemberExpr')
    expect(mem.property).toBe('x')
    const call = mem.object as ast.CallExpr
    expect(call.kind).toBe('CallExpr')
    expect(call.args).toHaveLength(2)
  })
})

describe('AST: import with version tag', () => {
  it('captures version', () => {
    const p = parseValid(`import { run } from "lib"@abc1234\nexport run`)
    const imp = p.items[0] as ast.Import
    expect(imp.kind).toBe('Import')
    expect(imp.source).toBe('lib')
    expect(imp.version).toBe('abc1234')
    const clause = imp.clause as ast.NamedImports
    expect(clause.kind).toBe('NamedImports')
    expect(clause.specs[0]!.name).toBe('run')
  })

  it('namespace import', () => {
    const p = parseValid(`import * as utils from "../u"\nfunc t() {} export t`)
    const imp = p.items[0] as ast.Import
    const clause = imp.clause as ast.NamespaceImport
    expect(clause.kind).toBe('NamespaceImport')
    expect(clause.alias).toBe('utils')
    expect(imp.version).toBeNull()
  })
})

describe('AST: destructuring', () => {
  it('object destruct with rename', () => {
    const p = parseValid(`
      fai f() -> rating: int, notes: string { }
      func t() { let { rating: r, notes } = f() }
      export t
    `)
    const fn = p.items[1] as ast.FuncDecl
    const letStmt = fn.body.stmts[0] as ast.LetDecl
    const tgt = letStmt.target as ast.ObjectDestruct
    expect(tgt.kind).toBe('ObjectDestruct')
    expect(tgt.fields[0]!.source).toBe('rating')
    expect(tgt.fields[0]!.local).toBe('r')
    expect(tgt.fields[1]!.source).toBe('notes')
    expect(tgt.fields[1]!.local).toBe('notes')
  })

  it('array destruct', () => {
    const p = parseValid(`func t() { let [a, b, c] = arr } export t`)
    const fn = p.items[0] as ast.FuncDecl
    const tgt = (fn.body.stmts[0] as ast.LetDecl).target as ast.ArrayDestruct
    expect(tgt.kind).toBe('ArrayDestruct')
    expect(tgt.names).toEqual(['a', 'b', 'c'])
  })
})

describe('AST: object literal', () => {
  it('shorthand and key:value', () => {
    const p = parseValid(`func t() { let o = { x, y: 2, "z": 3 } } export t`)
    const fn = p.items[0] as ast.FuncDecl
    const lit = (fn.body.stmts[0] as ast.LetDecl).init as ast.ObjectLit
    expect(lit.fields).toHaveLength(3)
    expect(lit.fields[0]!.key).toBe('x')
    expect(lit.fields[0]!.shorthand).toBe(true)
    expect((lit.fields[0]!.value as ast.IdentExpr).name).toBe('x')
    expect(lit.fields[1]!.key).toBe('y')
    expect(lit.fields[1]!.shorthand).toBe(false)
    expect(lit.fields[2]!.key).toBe('z')
  })
})

describe('AST: annotations on fai/func', () => {
  it('@cache @timeout(900) attached to fai', () => {
    const p = parseValid(`
      @cache
      @timeout(900)
      fai heavy(x: int, prompt: prompt) -> r: int { }
      export heavy
    `)
    const fai = p.items[0] as ast.FaiDecl
    expect(fai.annotations).toHaveLength(2)
    expect(fai.annotations[0]!.name).toBe('cache')
    expect(fai.annotations[0]!.args).toHaveLength(0)
    expect(fai.annotations[1]!.name).toBe('timeout')
    expect(fai.annotations[1]!.args).toHaveLength(1)
    expect((fai.annotations[1]!.args[0]!.value as ast.IntLit).value).toBe(900)
  })

  it('@runtime keyword args', () => {
    const p = parseValid(`
      @runtime(adapter = "claude", maxLlmRetries = 3)
      fai f(x: int) -> r: int { }
      export f
    `)
    const rt = p.items[0] as ast.RuntimeAnnotation
    expect(rt.kind).toBe('RuntimeAnnotation')
    expect(rt.name).toBe('runtime')
    expect(rt.args).toHaveLength(2)
    expect(rt.args[0]!.key).toBe('adapter')
    expect((rt.args[0]!.value as ast.StringLit).value).toBe('claude')
    expect(rt.args[1]!.key).toBe('maxLlmRetries')
    expect((rt.args[1]!.value as ast.IntLit).value).toBe(3)
  })
})

describe('AST: control flow', () => {
  it('if/else-if/else captures all branches', () => {
    const p = parseValid(`
      func t(x: int) -> int {
        if (x > 0) { return 1 }
        else if (x == 0) { return 0 }
        else { return -1 }
      }
      export t
    `)
    const fn = p.items[0] as ast.FuncDecl
    const ifs = fn.body.stmts[0] as ast.IfStmt
    expect(ifs.kind).toBe('IfStmt')
    expect(ifs.elifs).toHaveLength(1)
    expect(ifs.otherwise).not.toBeNull()
  })

  it('try-catch with multiple catches and binding', () => {
    const p = parseValid(`
      func t() {
        try { let r = 1 }
        catch ValidationError as e { let x = e }
        catch TimeoutError { let y = 1 }
      }
      export t
    `)
    const fn = p.items[0] as ast.FuncDecl
    const tryS = fn.body.stmts[0] as ast.TryStmt
    expect(tryS.kind).toBe('TryStmt')
    expect(tryS.catches).toHaveLength(2)
    expect(tryS.catches[0]!.errorType).toBe('ValidationError')
    expect(tryS.catches[0]!.binding).toBe('e')
    expect(tryS.catches[1]!.errorType).toBe('TimeoutError')
    expect(tryS.catches[1]!.binding).toBeNull()
  })
})

describe('AST: structural types', () => {
  it('enum type variants', () => {
    const p = parseValid(`
      fai f(x: int) -> r: enum: a|b|c { }
      export f
    `)
    const fai = p.items[0] as ast.FaiDecl
    const t = fai.outputs[0]!.type as ast.EnumType
    expect(t.kind).toBe('EnumType')
    expect(t.variants).toEqual(['a', 'b', 'c'])
  })

  it('array<T> with constraint', () => {
    const p = parseValid(`
      fai f() -> r: array<int> minLen=1 { }
      export f
    `)
    const fai = p.items[0] as ast.FaiDecl
    const t = fai.outputs[0]!.type as ast.ArrayType
    expect(t.kind).toBe('ArrayType')
    expect((t.element as ast.ScalarType).name).toBe('int')
    expect(t.constraint?.key).toBe('minLen')
    expect(t.constraint?.value).toBe(1)
  })

  it('nested object/array type', () => {
    const p = parseValid(`
      fai f() -> r: object{ items: array<object{ x: int }>, k: string } { }
      export f
    `)
    const fai = p.items[0] as ast.FaiDecl
    const obj = fai.outputs[0]!.type as ast.ObjectType
    expect(obj.kind).toBe('ObjectType')
    expect(obj.fields).toHaveLength(2)
    const items = obj.fields[0]!.type as ast.ArrayType
    expect(items.kind).toBe('ArrayType')
    const elemObj = items.element as ast.ObjectType
    expect(elemObj.kind).toBe('ObjectType')
    expect(elemObj.fields[0]!.name).toBe('x')
  })
})

// ─── Corpus visitor sweep ───────────────────────────────────────────────

describe('AST: every valid fixture visits without throwing', () => {
  const validDir = join(FIXTURES_DIR, 'valid')
  const files = readdirSync(validDir)
    .filter((f) => f.endsWith('.tr'))
    .sort()

  it('has expected number of fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(50)
  })

  for (const f of files) {
    it(f, () => {
      const src = readFileSync(join(validDir, f), 'utf8')
      const r = parseToAst(src)
      expect(r.lexErrors).toEqual([])
      expect(r.parseErrors).toEqual([])
      expect(r.ast).not.toBeNull()
      expect(r.ast!.kind).toBe('Program')
    })
  }
})

describe('AST: ranges are populated', () => {
  it('top-level items have non-empty ranges', () => {
    const p = parseValid(`
      const X: int = 5
      func t() { return X }
      export t
    `)
    for (const item of p.items) {
      const r = (item as any).range as ast.Range
      expect(r.endOffset).toBeGreaterThan(r.startOffset)
    }
  })
})
