/**
 * Interpreter tests — M2 scope.
 *
 * Covers running pure-compute train programs end-to-end:
 *   parse -> AST -> runProgram -> Value
 *
 * fai functions are stubbed to throw a known error (M3 will replace
 * with real adapter calls).
 */

import { describe, it, expect } from 'vitest'
import { runSource } from '../src/index.js'

function run(src: string, args: unknown[] = []) {
  return runSource(src, { args: args as any })
}

function ok(src: string, args: unknown[] = []) {
  const r = run(src, args)
  if (!r.ok) {
    const diag = [
      r.error ? `runtime: ${r.error.message}` : null,
      r.lexErrors.length > 0 ? `lex: ${JSON.stringify(r.lexErrors)}` : null,
      r.parseErrors.length > 0
        ? `parse: ${(r.parseErrors as any[]).map((e) => e.message).join('; ')}`
        : null,
    ]
      .filter(Boolean)
      .join(' | ')
    throw new Error(`expected ok, got: ${diag}`)
  }
  return r.value
}

function fail(src: string, args: unknown[] = []) {
  const r = run(src, args)
  expect(r.ok).toBe(false)
  return r.error
}

// ─── Smoke: hello-world style ────────────────────────────────────────

describe('interpreter: basics', () => {
  it('returns an int literal', () => {
    expect(ok(`func main() -> int { return 42 } export main`)).toBe(42)
  })

  it('returns a string literal', () => {
    expect(ok(`func main() -> string { return "hi" } export main`)).toBe('hi')
  })

  it('arithmetic', () => {
    expect(ok(`func main() -> int { return 1 + 2 * 3 } export main`)).toBe(7)
    expect(
      ok(`func main() -> int { return (1 + 2) * 3 } export main`),
    ).toBe(9)
    expect(
      ok(`func main() -> float { return 10 / 4 } export main`),
    ).toBeCloseTo(2.5)
    expect(ok(`func main() -> int { return 10 % 3 } export main`)).toBe(1)
  })

  it('division by zero is a runtime error', () => {
    const e = fail(`func main() { return 1 / 0 } export main`)
    expect(e?.errorType).toBe('RuntimeError')
    expect(e?.message).toMatch(/division by zero/)
  })

  it('comparison + boolean ops', () => {
    expect(ok(`func main() -> bool { return 1 < 2 && 3 > 2 } export main`)).toBe(true)
    expect(ok(`func main() -> bool { return false || true } export main`)).toBe(true)
    expect(ok(`func main() -> bool { return !true } export main`)).toBe(false)
  })

  it('ternary', () => {
    expect(
      ok(`func main() -> string { let x = 5; return x > 0 ? "pos" : "neg" } export main`),
    ).toBe('pos')
  })

  it('args passed to main', () => {
    expect(
      ok(
        `func main(x: int, y: int) -> int { return x + y } export main`,
        [2, 3],
      ),
    ).toBe(5)
  })
})

// ─── Variables & scoping ─────────────────────────────────────────────

describe('interpreter: variables', () => {
  it('top-level const + var read', () => {
    expect(
      ok(`
        const N: int = 10
        var counter: int = 0
        func main() -> int { return N + counter }
        export main
      `),
    ).toBe(10)
  })

  it('var can be reassigned, const cannot', () => {
    expect(
      ok(`
        var x: int = 5
        func main() -> int { x = 100; return x }
        export main
      `),
    ).toBe(100)

    const e = fail(`
      const X: int = 5
      func main() { X = 10 }
      export main
    `)
    expect(e?.message).toMatch(/cannot reassign const/)
  })

  it('let scopes are block-local', () => {
    const e = fail(`
      func main() -> int {
        if (true) { let inner = 1 }
        return inner
      }
      export main
    `)
    expect(e?.message).toMatch(/Undefined identifier 'inner'/)
  })

  it('compound assignment', () => {
    expect(
      ok(`
        var x: int = 10
        func main() -> int {
          x += 5
          x *= 2
          x -= 1
          return x
        }
        export main
      `),
    ).toBe(29)
  })
})

// ─── Strings & templates ─────────────────────────────────────────────

describe('interpreter: strings', () => {
  it('plain concat with +', () => {
    expect(
      ok(`func main() -> string { return "a" + "b" + "c" } export main`),
    ).toBe('abc')
  })

  it('template string interpolation', () => {
    expect(
      ok(`
        func main(name: string) -> string {
          let count = 3
          return "hi \${name}, you have \${count + 1} messages"
        }
        export main
      `, ['Tom']),
    ).toBe('hi Tom, you have 4 messages')
  })

  it('upper/lower/trim/split/concat', () => {
    expect(ok(`func main() -> string { return upper("abc") } export main`)).toBe(
      'ABC',
    )
    expect(
      ok(`func main() -> string { return lower("ABC") } export main`),
    ).toBe('abc')
    expect(
      ok(`func main() -> string { return trim("  hi  ") } export main`),
    ).toBe('hi')
    expect(
      ok(`func main() -> int { let p = split("a,b,c", ","); return len(p) } export main`),
    ).toBe(3)
    expect(
      ok(`func main() -> string { return concat("x", 1, true) } export main`),
    ).toBe('x1true')
  })
})

// ─── Arrays & objects ────────────────────────────────────────────────

describe('interpreter: collections', () => {
  it('array literal + len + push/pop', () => {
    expect(
      ok(`
        func main() -> int {
          let arr = [1, 2, 3]
          push(arr, 4)
          push(arr, 5)
          pop(arr)
          return len(arr)
        }
        export main
      `),
    ).toBe(4)
  })

  it('array index and member', () => {
    expect(
      ok(`
        func main() -> int {
          let arr = [10, 20, 30]
          return arr[1]
        }
        export main
      `),
    ).toBe(20)
  })

  it('object literal + keys + values + member', () => {
    const r = ok(`
      func main() -> int {
        let o = { a: 1, b: 2, c: 3 }
        return o.b + len(keys(o))
      }
      export main
    `)
    expect(r).toBe(5) // 2 + 3
  })

  it('contains for array and string', () => {
    expect(
      ok(
        `func main() -> bool { return contains([1, 2, 3], 2) } export main`,
      ),
    ).toBe(true)
    expect(
      ok(
        `func main() -> bool { return contains("hello", "ell") } export main`,
      ),
    ).toBe(true)
  })

  it('range builtin', () => {
    expect(
      ok(`func main() -> int { return sum(range(5)) } export main`),
    ).toBe(10) // 0+1+2+3+4
    expect(
      ok(`func main() -> int { return sum(range(1, 5)) } export main`),
    ).toBe(10) // 1+2+3+4
    expect(
      ok(`func main() -> int { return len(range(0, 10, 2)) } export main`),
    ).toBe(5)
  })
})

// ─── Destructuring ───────────────────────────────────────────────────

describe('interpreter: destructuring', () => {
  it('object destructure', () => {
    expect(
      ok(`
        func main() -> int {
          let o = { a: 1, b: 2 }
          let { a, b: y } = o
          return a + y
        }
        export main
      `),
    ).toBe(3)
  })

  it('array destructure', () => {
    expect(
      ok(`
        func main() -> int {
          let [a, b, c] = [10, 20, 30]
          return a + b + c
        }
        export main
      `),
    ).toBe(60)
  })
})

// ─── Control flow ────────────────────────────────────────────────────

describe('interpreter: control flow', () => {
  it('if / else if / else', () => {
    const src = `
      func classify(x: int) -> string {
        if (x > 0) { return "pos" }
        else if (x == 0) { return "zero" }
        else { return "neg" }
      }
      func main(x: int) -> string { return classify(x) }
      export main
    `
    expect(ok(src, [5])).toBe('pos')
    expect(ok(src, [0])).toBe('zero')
    expect(ok(src, [-3])).toBe('neg')
  })

  it('for-in over array sums', () => {
    expect(
      ok(`
        func main() -> int {
          let total = 0
          for x in [1, 2, 3, 4] {
            total += x
          }
          return total
        }
        export main
      `),
    ).toBe(10)
  })

  it('for-in with break and continue', () => {
    expect(
      ok(`
        func main() -> int {
          let sum = 0
          for x in range(10) {
            if (x == 7) { break }
            if (x % 2 == 0) { continue }
            sum += x
          }
          return sum
        }
        export main
      `),
    ).toBe(9) // 1+3+5
  })

  it('while loop', () => {
    expect(
      ok(`
        func main() -> int {
          let i = 0
          let sum = 0
          while (i < 5) {
            sum += i
            i += 1
          }
          return sum
        }
        export main
      `),
    ).toBe(10)
  })
})

// ─── Try / catch ─────────────────────────────────────────────────────

describe('interpreter: exceptions', () => {
  it('catches RuntimeError', () => {
    expect(
      ok(`
        func main() -> string {
          try {
            let x = 1 / 0
            return "unreachable"
          } catch RuntimeError as e {
            return e.message
          }
        }
        export main
      `),
    ).toMatch(/division by zero/)
  })

  it('uncaught error type propagates', () => {
    const e = fail(`
      func main() -> string {
        try {
          let x = 1 / 0
        } catch ValidationError as e {
          return "caught"
        }
        return "after"
      }
      export main
    `)
    expect(e?.errorType).toBe('RuntimeError')
  })
})

// ─── User-defined functions ──────────────────────────────────────────

describe('interpreter: functions', () => {
  it('recursive function', () => {
    expect(
      ok(`
        func fact(n: int) -> int {
          if (n <= 1) { return 1 }
          return n * fact(n - 1)
        }
        func main() -> int { return fact(5) }
        export main
      `),
    ).toBe(120)
  })

  it('mutual recursion', () => {
    expect(
      ok(`
        func is_even(n: int) -> bool {
          if (n == 0) { return true }
          return is_odd(n - 1)
        }
        func is_odd(n: int) -> bool {
          if (n == 0) { return false }
          return is_even(n - 1)
        }
        func main() -> bool { return is_even(10) }
        export main
      `),
    ).toBe(true)
  })

  it('arity mismatch is a runtime error', () => {
    const e = fail(`
      func f(x: int, y: int) -> int { return x + y }
      func main() -> int { return f(1) }
      export main
    `)
    expect(e?.message).toMatch(/expects 2 arg/)
  })
})

// ─── Fai stub ────────────────────────────────────────────────────────

describe('interpreter: fai stubs', () => {
  it('calling a fai throws unimplemented (M3 will replace)', () => {
    const e = fail(`
      fai score(x: int, prompt: prompt) -> r: int 0-10 { }
      func main() -> int {
        let r = score(5, "rate this")
        return r.r
      }
      export main
    `)
    expect(e?.errorType).toBe('RuntimeError')
    expect(e?.message).toMatch(/no LLM adapter installed/)
  })
})

// ─── Export forms ────────────────────────────────────────────────────

describe('interpreter: exports', () => {
  it('non-existent entry returns error', () => {
    const e = fail(`func go() { return } export go`)
    expect(e?.message).toMatch(/no export named 'main' found/)
  })

  it('custom entry option', () => {
    const r = runSource(
      `func go() -> int { return 42 } export go`,
      { entry: 'go' },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(42)
  })

  it('export alias', () => {
    const r = runSource(
      `func impl() -> int { return 99 } export impl as main`,
      {},
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(99)
  })

  it('inline export func', () => {
    const r = runSource(`export func main() -> int { return 7 }`, {})
    expect(r.ok).toBe(true)
    expect(r.value).toBe(7)
  })
})

// ─── Lexical scoping (closures-light) ────────────────────────────────

describe('interpreter: scoping', () => {
  it('inner functions see outer top-level vars', () => {
    expect(
      ok(`
        const A: int = 100
        var b: int = 5
        func helper() -> int { return A + b }
        func main() -> int { return helper() + 1 }
        export main
      `),
    ).toBe(106)
  })

  it('parameter shadows global var', () => {
    expect(
      ok(`
        var x: int = 999
        func f(x: int) -> int { return x }
        func main() -> int { return f(7) }
        export main
      `),
    ).toBe(7)
  })
})
