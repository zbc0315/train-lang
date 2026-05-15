import { describe, test, expect } from 'vitest'
import { runSource } from '../src/index.js'
import {
  createGenerativeFakeAdapter,
  createChaosAdapter,
} from '@tom2012/train-adapter-fake-gen'

/**
 * Integration: fake-gen Layer 3 × core retry-with-feedback loop.
 *
 * The interpreter retries fai calls up to maxFaiAttempts when the
 * adapter returns broken outputs that fail schema validation. These
 * tests prove that retryConverge mode converges within bounds and
 * that ChaosAdapter terminates appropriately.
 */

const SCORE_SRC = `
fai score(text: string, prompt: prompt) -> rating: int 0-10, comment: string maxLen=200 { }

func main() -> int {
  let r = score("hello", "rate this from 0 to 10")
  return r.rating
}

export main
`

describe('retry-with-feedback: fake-gen × core', () => {
  test('clean adapter succeeds on first attempt', async () => {
    const adapter = createGenerativeFakeAdapter({ seed: 1, faultRate: 0 })
    const r = await runSource(SCORE_SRC, {
      adapter,
      maxFaiAttempts: 3,
    })
    expect(r.ok).toBe(true)
    expect(adapter.calls.length).toBe(1)
  })

  test('retryConverge failTimes=2 + maxFaiAttempts=3 → 3 calls; attempt counter advanced; final attempt=2', async () => {
    const adapter = createGenerativeFakeAdapter({
      seed: 1,
      retryConverge: { failTimes: 2, mode: 'missingField' },
    })
    const r = await runSource(SCORE_SRC, {
      adapter,
      maxFaiAttempts: 3,
    })
    // Strong assertion: retry path was actually exercised, not bypassed.
    expect(adapter.calls.length).toBe(3)
    expect(adapter.calls[0]!.options.attempt).toBe(0)
    expect(adapter.calls[1]!.options.attempt).toBe(1)
    expect(adapter.calls[2]!.options.attempt).toBe(2)
    // First two attempts must have observed faulted output:
    expect(adapter.faultsInjected[0]).toBe('missingField')
    expect(adapter.faultsInjected[1]).toBe('missingField')
    expect(adapter.faultsInjected[2]).toBeNull()
    // The retry prompts must be different from the initial prompt
    // (interpreter appends retry feedback). They should be strictly longer.
    expect(adapter.calls[1]!.prompt.length).toBeGreaterThan(
      adapter.calls[0]!.prompt.length,
    )
    expect(adapter.calls[2]!.prompt.length).toBeGreaterThan(
      adapter.calls[0]!.prompt.length,
    )
    expect(r.ok).toBe(true)
  })

  test('retryConverge failTimes=5 exceeds maxFaiAttempts=3 → run fails', async () => {
    const adapter = createGenerativeFakeAdapter({
      seed: 1,
      retryConverge: { failTimes: 5, mode: 'missingField' },
    })
    const r = await runSource(SCORE_SRC, {
      adapter,
      maxFaiAttempts: 3,
    })
    expect(r.ok).toBe(false)
    expect(adapter.calls.length).toBe(3)
  })

  test('INV-9 (retry termination): adapter never called more than maxFaiAttempts', async () => {
    const adapter = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['missingField'],
    })
    await runSource(SCORE_SRC, { adapter, maxFaiAttempts: 4 })
    expect(adapter.calls.length).toBeLessThanOrEqual(4)
  })

  test('missingField fault is reliably rejected by validator (anchors retry behavior)', async () => {
    // Anchor test: missingField MUST trigger retry. Other modes
    // (wrongType / arrayInsteadObject / extraField) have varying
    // validator behaviors — see 工作流DSL测试方案.md §18.9 known risk
    // about validator tolerance and §6.3 故障锚定表 for the formal
    // contract once validator is hardened.
    const adapter = createGenerativeFakeAdapter({
      seed: 1,
      retryConverge: { failTimes: 1, mode: 'missingField' },
    })
    const r = await runSource(SCORE_SRC, { adapter, maxFaiAttempts: 3 })
    expect(adapter.calls.length).toBeGreaterThanOrEqual(2)
    expect(adapter.calls[0]!.options.attempt).toBe(0)
    expect(adapter.calls[1]!.options.attempt).toBe(1)
    expect(r.ok).toBe(true) // converges by attempt 1
  })

  test('validator tolerance matrix (informational, no hard fail)', async () => {
    // For each fault mode, record whether the validator rejected it (=
    // triggered retry) or tolerated it. This data informs §6.3 锚定表
    // updates without breaking when validator tolerance changes.
    const modes = ['missingField', 'wrongType', 'arrayInsteadObject'] as const
    const observed: Record<string, { calls: number; rejected: boolean }> = {}
    for (const mode of modes) {
      const adapter = createGenerativeFakeAdapter({
        seed: 1,
        retryConverge: { failTimes: 1, mode },
      })
      await runSource(SCORE_SRC, { adapter, maxFaiAttempts: 3 })
      observed[mode] = {
        calls: adapter.calls.length,
        rejected: adapter.calls.length >= 2,
      }
    }
    // Print matrix (visible in vitest --reporter=verbose)
    // Hard invariant: missingField MUST be rejected.
    expect(observed.missingField!.rejected).toBe(true)
    // Total call count is bounded by maxFaiAttempts.
    for (const m of modes) {
      expect(observed[m]!.calls).toBeLessThanOrEqual(3)
    }
  })

  test('retryConverge.failTimes=0 → no faults, first-call success', async () => {
    const adapter = createGenerativeFakeAdapter({
      seed: 1,
      retryConverge: { failTimes: 0, mode: 'missingField' },
    })
    const r = await runSource(SCORE_SRC, { adapter, maxFaiAttempts: 3 })
    expect(r.ok).toBe(true)
    expect(adapter.calls.length).toBe(1)
    expect(adapter.faultsInjected[0]).toBeNull()
  })
})

describe('Chaos adapter integration', () => {
  test('timeout chaos → run fails with TimeoutError', async () => {
    const adapter = createChaosAdapter({ mode: 'timeout' })
    const r = await runSource(SCORE_SRC, { adapter, maxFaiAttempts: 1 })
    expect(r.ok).toBe(false)
    expect(r.error?.errorType).toMatch(/Timeout/i)
  })

  test('unrecoverable error chaos → run fails with RuntimeError', async () => {
    const adapter = createChaosAdapter({
      mode: 'unrecoverable-error',
      message: 'simulated outage',
    })
    const r = await runSource(SCORE_SRC, { adapter, maxFaiAttempts: 3 })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('simulated outage')
    // unrecoverable: should not retry
    expect(adapter.calls.length).toBe(1)
  })

  test('cancel chaos → run fails with cancellation error', async () => {
    const adapter = createChaosAdapter({ mode: 'cancel' })
    const r = await runSource(SCORE_SRC, { adapter, maxFaiAttempts: 1 })
    expect(r.ok).toBe(false)
    expect(r.error?.errorType).toMatch(/UserCancel|cancel/i)
  })

  test('throw chaos → propagates as uncaught exception (not wrapped)', async () => {
    const adapter = createChaosAdapter({ mode: 'throw', message: 'kaboom' })
    await expect(
      runSource(SCORE_SRC, { adapter, maxFaiAttempts: 1 }),
    ).rejects.toThrow(/kaboom/)
  })
})
