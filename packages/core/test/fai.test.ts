/**
 * End-to-end fai execution tests (M3).
 *
 * Uses the in-process mock adapter to validate:
 *  - prompt composition: data inputs + prompt-typed inputs + outputs block
 *  - dispatch: interpreter calls adapter.call with the right FaiCall
 *  - validation: outputs are checked against the declared schema
 *  - retry-with-feedback: validation failure re-prompts up to maxAttempts
 *  - error propagation: adapter timeout/error/cancel surface correctly
 *  - inline / structured / object output shapes
 */

import { describe, it, expect } from 'vitest'
import { runSource } from '../src/index.js'
import {
  createMockAdapter,
  createReactiveMockAdapter,
  success,
  adapterError,
  timeout as timeoutResult,
} from '@train-lang/adapter-mock'
import type { FaiCall } from '@train-lang/adapter-spec'

// ─── Basic dispatch ──────────────────────────────────────────────────

describe('fai dispatch via adapter', () => {
  it('calls adapter once and returns validated outputs', async () => {
    const adapter = createMockAdapter([
      { result: success({ message: 'Hi, Tom!' }) },
    ])
    const r = await runSource(
      `
      fai greet(name: string, prompt: prompt) -> message: string maxLen=200 { }
      func main(name: string) -> string {
        let r = greet(name, "polite hello to \${name}")
        return r.message
      }
      export main
      `,
      { adapter, args: ['Tom'] },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe('Hi, Tom!')
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]!.fnName).toBe('greet')
  })

  it('prompt composition includes inputs, task, outputs sections', async () => {
    let received: FaiCall | null = null
    const adapter = createReactiveMockAdapter((req) => {
      received = req
      return success({ rating: 8 })
    })
    await runSource(
      `
      fai score(item: string, criteria: string, prompt: prompt) -> rating: int 0-10 { }
      func main() -> int {
        let r = score("readme", "clarity", "rate the readme")
        return r.rating
      }
      export main
      `,
      { adapter },
    )
    expect(received).not.toBeNull()
    const p = received!.prompt
    expect(p).toMatch(/\[Inputs\]/)
    expect(p).toMatch(/item\(string\) = "readme"/)
    expect(p).toMatch(/criteria\(string\) = "clarity"/)
    expect(p).toMatch(/\[Task\]/)
    expect(p).toMatch(/rate the readme/)
    expect(p).toMatch(/\[Required outputs/)
    expect(p).toMatch(/rating: int 0-10/)
    // JSON instruction since writesWorkflowData=false
    expect(p).toMatch(/JSON object/)
  })

  it('inputs map has structured types and values', async () => {
    let received: FaiCall | null = null
    const adapter = createReactiveMockAdapter((req) => {
      received = req
      return success({ rating: 5 })
    })
    await runSource(
      `
      fai score(item: string, count: int, prompt: prompt) -> rating: int 0-10 { }
      func main() -> int {
        let r = score("x", 7, "any prompt")
        return r.rating
      }
      export main
      `,
      { adapter },
    )
    expect(received!.inputs).toEqual({
      item: { type: { kind: 'scalar', base: 'string' }, value: 'x' },
      count: { type: { kind: 'scalar', base: 'int' }, value: 7 },
    })
    expect(received!.outputs).toEqual({
      rating: {
        type: {
          kind: 'scalar',
          base: 'int',
          constraint: { kind: 'range', min: 0, max: 10 },
        },
      },
    })
  })

  it('multiple outputs as a structured object', async () => {
    const adapter = createMockAdapter([
      { result: success({ rating: 7, notes: 'pretty good' }) },
    ])
    const r = await runSource(
      `
      fai analyze(item: string, prompt: prompt)
        -> rating: int 0-10, notes: string maxLen=100 { }
      func main() -> int {
        let { rating, notes } = analyze("x", "rate it")
        return rating
      }
      export main
      `,
      { adapter },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(7)
  })
})

// ─── Validation + retry ─────────────────────────────────────────────

describe('fai validation', () => {
  it('rejects wrong type and retries with feedback', async () => {
    let attempt = 0
    const adapter = createReactiveMockAdapter((_req) => {
      attempt++
      if (attempt === 1) return success({ rating: '8' as unknown as number })
      return success({ rating: 8 })
    })
    const r = await runSource(
      `
      fai score(item: string, prompt: prompt) -> rating: int 0-10 { }
      func main() -> int {
        let r = score("x", "rate")
        return r.rating
      }
      export main
      `,
      { adapter, maxFaiAttempts: 3 },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(8)
    expect(attempt).toBe(2) // first failed, second succeeded
    // retry prompt should contain feedback
    const secondPrompt = adapter.calls[1]!.prompt
    expect(secondPrompt).toMatch(/failed validation/)
    expect(secondPrompt).toMatch(/rating/)
  })

  it('rejects out-of-range value, retries', async () => {
    let attempt = 0
    const adapter = createReactiveMockAdapter(() => {
      attempt++
      if (attempt === 1) return success({ rating: 99 })
      return success({ rating: 5 })
    })
    const r = await runSource(
      `
      fai score(prompt: prompt) -> rating: int 0-10 { }
      func main() -> int { let r = score("rate"); return r.rating }
      export main
      `,
      { adapter, maxFaiAttempts: 3 },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(5)
  })

  it('exhausts retries → throws ValidationError', async () => {
    const adapter = createReactiveMockAdapter(() =>
      success({ rating: 99 }),
    )
    const r = await runSource(
      `
      fai score(prompt: prompt) -> rating: int 0-10 { }
      func main() -> int { let r = score("rate"); return r.rating }
      export main
      `,
      { adapter, maxFaiAttempts: 2 },
    )
    expect(r.ok).toBe(false)
    expect(r.error?.errorType).toBe('ValidationError')
    expect(adapter.calls).toHaveLength(2)
  })

  it('missing output key fails', async () => {
    const adapter = createMockAdapter([
      { result: success({}) },
      { result: success({}) },
      { result: success({}) },
    ])
    const r = await runSource(
      `
      fai score(prompt: prompt) -> rating: int { }
      func main() -> int { let r = score("rate"); return r.rating }
      export main
      `,
      { adapter, maxFaiAttempts: 3 },
    )
    expect(r.ok).toBe(false)
    expect(r.error?.errorType).toBe('ValidationError')
  })

  it('enum constraint enforced', async () => {
    const adapter = createMockAdapter([
      { result: success({ verdict: 'maybe' }) }, // not in enum
      { result: success({ verdict: 'pass' }) }, // ok
    ])
    const r = await runSource(
      `
      fai check(prompt: prompt) -> verdict: enum: pass|fail|skip { }
      func main() -> string {
        let r = check("decide")
        return r.verdict
      }
      export main
      `,
      { adapter, maxFaiAttempts: 3 },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe('pass')
  })

  it('object type constraint enforced', async () => {
    const adapter = createMockAdapter([
      {
        result: success({
          result: { rating: 5, notes: 'ok' },
        }),
      },
    ])
    const r = await runSource(
      `
      fai analyze(prompt: prompt)
        -> result: object{ rating: int 0-10, notes: string maxLen=10 } { }
      func main() -> int {
        let r = analyze("rate")
        return r.result.rating
      }
      export main
      `,
      { adapter },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(5)
  })

  it('array<T> constraint enforced', async () => {
    const adapter = createMockAdapter([
      { result: success({ items: [1, 2, 3] }) },
    ])
    const r = await runSource(
      `
      fai gather(prompt: prompt) -> items: array<int> minLen=1 { }
      func main() -> int {
        let r = gather("list")
        return sum(r.items)
      }
      export main
      `,
      { adapter },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(6)
  })
})

// ─── Adapter-side errors ────────────────────────────────────────────

describe('fai error pathways', () => {
  it('adapter timeout → TimeoutError', async () => {
    const adapter = createMockAdapter([{ result: timeoutResult() }])
    const r = await runSource(
      `
      fai f(prompt: prompt) -> r: int { }
      func main() -> int { let x = f("..."); return x.r }
      export main
      `,
      { adapter, maxFaiAttempts: 1 },
    )
    expect(r.ok).toBe(false)
    expect(r.error?.errorType).toBe('TimeoutError')
  })

  it('adapter unrecoverable error → RuntimeError', async () => {
    const adapter = createMockAdapter([
      { result: adapterError('rate limited', false) },
    ])
    const r = await runSource(
      `
      fai f(prompt: prompt) -> r: int { }
      func main() -> int { let x = f("..."); return x.r }
      export main
      `,
      { adapter, maxFaiAttempts: 3 },
    )
    expect(r.ok).toBe(false)
    expect(r.error?.errorType).toBe('RuntimeError')
    expect(r.error?.message).toMatch(/rate limited/)
  })

  it('adapter recoverable error → retries', async () => {
    let attempt = 0
    const adapter = createReactiveMockAdapter(() => {
      attempt++
      if (attempt === 1) return adapterError('transient blip', true)
      return success({ r: 42 })
    })
    const r = await runSource(
      `
      fai f(prompt: prompt) -> r: int { }
      func main() -> int { let x = f("..."); return x.r }
      export main
      `,
      { adapter, maxFaiAttempts: 3 },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(42)
  })

  it('catch ValidationError inside train code', async () => {
    const adapter = createReactiveMockAdapter(() =>
      success({ rating: 999 }),
    )
    const r = await runSource(
      `
      fai score(prompt: prompt) -> rating: int 0-10 { }
      func main() -> string {
        try {
          let r = score("rate")
          return "ok"
        } catch ValidationError as e {
          return "caught: " + e.type
        }
      }
      export main
      `,
      { adapter, maxFaiAttempts: 2 },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe('caught: ValidationError')
  })
})

// ─── Adapter capabilities flag ──────────────────────────────────────

describe('fai adapter capabilities', () => {
  it('writesWorkflowData=true changes prompt wording', async () => {
    let received: FaiCall | null = null
    const adapter = createReactiveMockAdapter(
      (req) => {
        received = req
        return success({ r: 1 })
      },
      { writesWorkflowData: true },
    )
    await runSource(
      `
      fai f(prompt: prompt) -> r: int { }
      func main() -> int { let x = f("..."); return x.r }
      export main
      `,
      { adapter },
    )
    expect(received!.prompt).toMatch(/workflow_data\.json/)
    expect(received!.prompt).not.toMatch(/JSON object/)
  })
})

// ─── Multi-fai program ──────────────────────────────────────────────

describe('fai multi-call programs', () => {
  it('two fai functions called in sequence', async () => {
    const adapter = createMockAdapter([
      { fn: 'extract', result: success({ keywords: ['a', 'b', 'c'] }) },
      { fn: 'score', result: success({ rating: 8 }) },
    ])
    const r = await runSource(
      `
      fai extract(text: string, prompt: prompt) -> keywords: array<string> { }
      fai score(words: array<string>, prompt: prompt) -> rating: int 0-10 { }
      func main(text: string) -> int {
        let ex = extract(text, "list 3 keywords")
        let sc = score(ex.keywords, "rate these")
        return sc.rating
      }
      export main
      `,
      { adapter, args: ['hello world hello'] },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(8)
    expect(adapter.calls).toHaveLength(2)
  })

  it('fai inside a for loop', async () => {
    const adapter = createReactiveMockAdapter((req) => {
      const item = (req.inputs.item!.value as string).length
      return success({ rating: item })
    })
    const r = await runSource(
      `
      fai rate(item: string, prompt: prompt) -> rating: int { }
      func main() -> int {
        let total = 0
        for w in ["a", "bb", "ccc"] {
          let r = rate(w, "score the word")
          total += r.rating
        }
        return total
      }
      export main
      `,
      { adapter },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe(1 + 2 + 3)
    expect(adapter.calls).toHaveLength(3)
  })
})
