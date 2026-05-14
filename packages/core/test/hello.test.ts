/**
 * Smoke test: confirms M1 PoC subset can lex + parse the minimal
 * "hello.tr" example without errors. This is the acceptance gate
 * for chevrotain as the parser library.
 */

import { describe, it, expect } from 'vitest'
import { tokenize, parse } from '../src/index.js'

const HELLO_TR = `
// hello.tr — minimal example flow
fai greet(name: string, prompt: prompt) -> message: string maxLen=200 { }

func main(name: string) -> string {
  let r = greet(name, "请用礼貌的方式问候")
  return r.message
}

export main
`

describe('hello.tr smoke test', () => {
  it('tokenizes without lexer errors', () => {
    const result = tokenize(HELLO_TR)
    expect(result.tokens.length).toBeGreaterThan(20)
    expect(result.errors).toEqual([])

    const names = result.tokens.map((t) => t.tokenType.name)
    // Sanity: contains the expected keyword shape
    expect(names).toContain('Fai')
    expect(names).toContain('Func')
    expect(names).toContain('Export')
    expect(names).toContain('Return')
    expect(names).toContain('Let')
    expect(names).toContain('Arrow')
    expect(names).toContain('StringLit')
    // Leaf types (`string`, `prompt`) lex as Identifier — disambiguated later
    expect(names).toContain('Identifier')
  })

  it('parses without parser errors', () => {
    const result = parse(HELLO_TR)
    expect(result.lexErrors).toEqual([])
    expect(result.parseErrors).toEqual([])
    expect(result.cst).toBeDefined()
    expect(result.cst?.name).toBe('program')
  })
})

describe('individual constructs', () => {
  it('parses fai with single output', () => {
    const result = parse(
      `fai f(x: int) -> r: int 0-10 { }`,
    )
    expect(result.parseErrors).toEqual([])
  })

  it('parses fai with multiple outputs', () => {
    const result = parse(
      `fai f(x: int, prompt: prompt) -> rating: int 0-10, notes: string maxLen=500 { }`,
    )
    expect(result.parseErrors).toEqual([])
  })

  it('parses func with no params and no return type', () => {
    const result = parse(`func go() { let x = 1 }`)
    expect(result.parseErrors).toEqual([])
  })

  it('parses func with optional param types', () => {
    const result = parse(`func add(x, y) -> int { return 0 }`)
    expect(result.parseErrors).toEqual([])
  })

  it('parses member access and function call chain', () => {
    const result = parse(
      `func t() { let x = greet(name, "hi").message.length }`,
    )
    expect(result.parseErrors).toEqual([])
  })

  it('rejects malformed input', () => {
    const result = parse(`func {{ broken`)
    expect(result.parseErrors.length).toBeGreaterThan(0)
  })

  it('handles line comments and block comments', () => {
    const result = parse(`
      // top comment
      /* block
         comment */
      func f() { /* inside */ return 1 }
      export f
    `)
    expect(result.parseErrors).toEqual([])
  })
})
