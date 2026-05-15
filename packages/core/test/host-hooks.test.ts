import { describe, test, expect } from 'vitest'
import { runSource } from '../src/index.js'
import { createReactiveMockAdapter } from '@tom2012/train-adapter-mock'

const SRC = `
fai foo(x: int, prompt: prompt) -> y: int { }

func main() -> int {
  let r = foo(42, "do something")
  return r.y
}

export main
`

describe('writeProtocolHint host hook', () => {
  test('default hint is the built-in JSON / agent-CLI section', async () => {
    const seen: string[] = []
    const adapter = createReactiveMockAdapter((req) => {
      seen.push(req.prompt)
      return { kind: 'success', outputs: { y: 7 } }
    })
    await runSource(SRC, { adapter })
    expect(seen[0]).toContain('JSON object')
  })

  test('writeProtocolHint replaces both default hints', async () => {
    const seen: string[] = []
    const adapter = createReactiveMockAdapter((req) => {
      seen.push(req.prompt)
      return { kind: 'success', outputs: { y: 7 } }
    })
    await runSource(SRC, {
      adapter,
      writeProtocolHint:
        '[Custom host protocol — write outputs to variables.X and set task_progress.finish.]',
    })
    expect(seen[0]).toContain('Custom host protocol')
    expect(seen[0]).not.toContain('JSON object')
    expect(seen[0]).not.toContain('stack[<callId>]')
  })
})

describe('async builtin support', () => {
  test('builtin returning Promise<Value> is awaited', async () => {
    const { makeBuiltin } = await import('../src/runtime.js')
    const asyncBuiltin = makeBuiltin('asyncEcho', async (args) => {
      await new Promise((r) => setTimeout(r, 10))
      return (args[0] as number) * 2
    })
    const src = `
func main() -> int {
  return asyncEcho(21)
}
export main
`
    const r = await runSource(src, {
      extraBuiltins: new Map([['asyncEcho', asyncBuiltin as any]]),
    })
    expect(r.ok).toBe(true)
    expect(r.value).toBe(42)
  })

  test('sync builtin still works (backward compat)', async () => {
    const { makeBuiltin } = await import('../src/runtime.js')
    const syncBuiltin = makeBuiltin('syncEcho', (args) => (args[0] as number) + 1)
    const src = `
func main() -> int {
  return syncEcho(7)
}
export main
`
    const r = await runSource(src, {
      extraBuiltins: new Map([['syncEcho', syncBuiltin as any]]),
    })
    expect(r.ok).toBe(true)
    expect(r.value).toBe(8)
  })

  test('async builtin that throws propagates', async () => {
    const { makeBuiltin } = await import('../src/runtime.js')
    const throwingBuiltin = makeBuiltin('asyncBoom', async () => {
      throw new Error('boom from builtin')
    })
    const src = `
func main() -> int { return asyncBoom() }
export main
`
    await expect(
      runSource(src, {
        extraBuiltins: new Map([['asyncBoom', throwingBuiltin as any]]),
      }),
    ).rejects.toThrow(/boom from builtin/)
  })
})

describe('AbortSignal host hook', () => {
  test('pre-aborted signal: fai call refuses to dispatch', async () => {
    const adapter = createReactiveMockAdapter(() => ({
      kind: 'success',
      outputs: { y: 1 },
    }))
    const ac = new AbortController()
    ac.abort()
    const r = await runSource(SRC, { adapter, signal: ac.signal })
    expect(r.ok).toBe(false)
    expect(r.error?.errorType).toMatch(/UserCancel|cancel/i)
    // The adapter was never called
    expect(adapter.calls.length).toBe(0)
  })

  test('signal forwarded to FaiCallOptions.signal', async () => {
    const ac = new AbortController()
    let received: AbortSignal | undefined
    const adapter = createReactiveMockAdapter((req) => {
      received = req.options.signal
      return { kind: 'success', outputs: { y: 1 } }
    })
    await runSource(SRC, { adapter, signal: ac.signal })
    expect(received).toBe(ac.signal)
  })

  test('signal aborted between attempts: subsequent retry skipped', async () => {
    const ac = new AbortController()
    let callCount = 0
    const adapter = createReactiveMockAdapter((req) => {
      callCount++
      if (callCount === 1) {
        ac.abort()
        // First call: return invalid output → would normally trigger retry
        return { kind: 'success', outputs: {} as any }
      }
      return { kind: 'success', outputs: { y: 7 } }
    })
    const r = await runSource(SRC, {
      adapter,
      signal: ac.signal,
      maxFaiAttempts: 3,
    })
    // Retry should be short-circuited by the abort check
    expect(callCount).toBe(1)
    expect(r.ok).toBe(false)
  })
})
