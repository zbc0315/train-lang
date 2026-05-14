/**
 * Tests for string template interpolation (M1 closeout).
 *
 * Verifies:
 *  - plain strings remain StringLit
 *  - strings with `${...}` produce TemplateString with alternating
 *    chunk / expr parts
 *  - inner expression types are preserved (BinaryExpr, MemberExpr, etc.)
 *  - `\${...}` escape is treated literally (no interpolation)
 *  - brace depth tracking handles `${ {a: 1}.a }` correctly
 */

import { describe, it, expect } from 'vitest'
import { parseToAst } from '../src/index.js'
import type * as ast from '../src/ast.js'

function letInit(src: string): ast.Expr {
  const r = parseToAst(`func t() { let x = ${src} } export t`)
  expect(r.parseErrors).toEqual([])
  expect(r.ast).not.toBeNull()
  const fn = r.ast!.items[0] as ast.FuncDecl
  return (fn.body.stmts[0] as ast.LetDecl).init!
}

describe('TemplateString', () => {
  it('plain string stays StringLit', () => {
    const e = letInit(`"hello world"`)
    expect(e.kind).toBe('StringLit')
    expect((e as ast.StringLit).value).toBe('hello world')
  })

  it('escapes are unescaped in plain string', () => {
    const e = letInit(`"a\\nb"`)
    expect(e.kind).toBe('StringLit')
    expect((e as ast.StringLit).value).toBe('a\nb')
  })

  it('escaped \\${...} is NOT treated as interpolation', () => {
    // Use a JS string literal (not template) so that the `${` sequence is
    // passed through verbatim to the train parser, where `\${...}` should
    // be treated as an escaped literal dollar-brace.
    const e = letInit('"price \\${x}"')
    expect(e.kind).toBe('StringLit')
    expect((e as ast.StringLit).value).toBe('price ${x}')
  })

  it('single interpolation produces TemplateString', () => {
    const e = letInit(`"hello \${name}"`)
    expect(e.kind).toBe('TemplateString')
    const t = e as ast.TemplateString
    // Invariant: first+last are chunks, so 3 parts here (last chunk empty)
    expect(t.parts).toHaveLength(3)
    expect(t.parts[0]!.kind).toBe('TemplateChunk')
    expect((t.parts[0] as ast.TemplateChunk).value).toBe('hello ')
    expect(t.parts[1]!.kind).toBe('TemplateExpr')
    const inner = (t.parts[1] as ast.TemplateExpr).expr as ast.IdentExpr
    expect(inner.kind).toBe('IdentExpr')
    expect(inner.name).toBe('name')
    expect((t.parts[2] as ast.TemplateChunk).value).toBe('')
  })

  it('multiple interpolations alternate chunk / expr', () => {
    const e = letInit(`"a=\${a}, b=\${b}, end"`)
    const t = e as ast.TemplateString
    expect(t.kind).toBe('TemplateString')
    expect(t.parts).toHaveLength(5)
    expect(t.parts.map((p) => p.kind)).toEqual([
      'TemplateChunk',
      'TemplateExpr',
      'TemplateChunk',
      'TemplateExpr',
      'TemplateChunk',
    ])
    expect((t.parts[0] as ast.TemplateChunk).value).toBe('a=')
    expect((t.parts[2] as ast.TemplateChunk).value).toBe(', b=')
    expect((t.parts[4] as ast.TemplateChunk).value).toBe(', end')
  })

  it('interpolation containing binary expression', () => {
    const e = letInit(`"sum=\${a + b * c}"`)
    const t = e as ast.TemplateString
    const expr = (t.parts[1] as ast.TemplateExpr).expr as ast.BinaryExpr
    expect(expr.kind).toBe('BinaryExpr')
    expect(expr.op).toBe('+')
    const right = expr.right as ast.BinaryExpr
    expect(right.op).toBe('*')
  })

  it('interpolation containing member access and call', () => {
    const e = letInit(`"x=\${obj.field}, c=\${f(1)}"`)
    const t = e as ast.TemplateString
    const m = (t.parts[1] as ast.TemplateExpr).expr as ast.MemberExpr
    expect(m.kind).toBe('MemberExpr')
    expect(m.property).toBe('field')
    const c = (t.parts[3] as ast.TemplateExpr).expr as ast.CallExpr
    expect(c.kind).toBe('CallExpr')
    expect(c.args).toHaveLength(1)
  })

  it('interpolation containing object literal with nested braces', () => {
    // brace tracking inside `${...}`: `{a: 1}` is well-balanced
    const e = letInit(`"r=\${ {a: 1}.a }"`)
    const t = e as ast.TemplateString
    const inner = (t.parts[1] as ast.TemplateExpr).expr as ast.MemberExpr
    expect(inner.kind).toBe('MemberExpr')
    expect(inner.property).toBe('a')
  })

  it('starts with interpolation', () => {
    const e = letInit(`"\${x} stuff"`)
    const t = e as ast.TemplateString
    expect(t.parts).toHaveLength(3)
    expect((t.parts[0] as ast.TemplateChunk).value).toBe('')
    expect(t.parts[1]!.kind).toBe('TemplateExpr')
    expect((t.parts[2] as ast.TemplateChunk).value).toBe(' stuff')
  })

  it('ends with interpolation', () => {
    const e = letInit(`"prefix \${y}"`)
    const t = e as ast.TemplateString
    // Invariant: first and last parts are always chunks (possibly empty)
    expect(t.parts).toHaveLength(3)
    expect((t.parts[0] as ast.TemplateChunk).value).toBe('prefix ')
    expect(t.parts[1]!.kind).toBe('TemplateExpr')
    expect((t.parts[2] as ast.TemplateChunk).value).toBe('')
  })

  it('only an interpolation', () => {
    const e = letInit(`"\${z}"`)
    const t = e as ast.TemplateString
    expect(t.parts).toHaveLength(3)
    expect(t.parts[0]!.kind).toBe('TemplateChunk')
    expect((t.parts[0] as ast.TemplateChunk).value).toBe('')
    expect(t.parts[1]!.kind).toBe('TemplateExpr')
    expect(t.parts[2]!.kind).toBe('TemplateChunk')
    expect((t.parts[2] as ast.TemplateChunk).value).toBe('')
  })
})

describe('TemplateString in real positions', () => {
  it('used as fai prompt arg', () => {
    const r = parseToAst(`
      fai greet(name: string, prompt: prompt) -> message: string { }
      func main(name: string) -> string {
        let r = greet(name, "hi \${name}, today is special")
        return r.message
      }
      export main
    `)
    expect(r.parseErrors).toEqual([])
    const fn = r.ast!.items[1] as ast.FuncDecl
    const letDecl = fn.body.stmts[0] as ast.LetDecl
    const call = letDecl.init as ast.CallExpr
    expect(call.kind).toBe('CallExpr')
    const promptArg = call.args[1]!
    expect(promptArg.kind).toBe('TemplateString')
  })
})
