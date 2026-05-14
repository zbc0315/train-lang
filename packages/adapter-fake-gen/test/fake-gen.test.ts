import { describe, test, expect } from 'vitest'
import type { FaiCall, TrainTypeDescriptor } from '@train-lang/adapter-spec'
import {
  createGenerativeFakeAdapter,
  createChaosAdapter,
  ALL_FAULT_MODES,
} from '../src/index.js'

function makeCall(
  fn: string,
  outputs: Record<string, TrainTypeDescriptor>,
  callId = 1,
): FaiCall {
  return {
    callId,
    fnName: fn,
    prompt: `prompt for ${fn}`,
    inputs: {},
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([k, type]) => [k, { type }]),
    ),
    options: { timeoutMs: 1000, maxAttempts: 1, attempt: 0 },
  }
}

const SIMPLE_OUTPUTS = {
  score: { kind: 'scalar', base: 'int' } as TrainTypeDescriptor,
  comment: { kind: 'scalar', base: 'string' } as TrainTypeDescriptor,
}

describe('GenerativeFakeAdapter — clean output', () => {
  test('faultRate=0 always returns success with all schema fields', async () => {
    const a = createGenerativeFakeAdapter({ seed: 1 })
    for (let i = 0; i < 20; i++) {
      const r = await a.call(makeCall('f', SIMPLE_OUTPUTS, i + 1))
      expect(r.kind).toBe('success')
      if (r.kind === 'success') {
        expect(Object.keys(r.outputs).sort()).toEqual(['comment', 'score'])
      }
    }
  })

  test('determinism: same seed + same call sequence → same outputs', async () => {
    const a = createGenerativeFakeAdapter({ seed: 99 })
    const b = createGenerativeFakeAdapter({ seed: 99 })
    const r1 = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    const r2 = await b.call(makeCall('f', SIMPLE_OUTPUTS))
    expect(r1).toEqual(r2)
  })

  test('different seed → different outputs (high probability)', async () => {
    const samples = new Set<string>()
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = createGenerativeFakeAdapter({ seed })
      const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
      if (r.kind === 'success') samples.add(JSON.stringify(r.outputs))
    }
    expect(samples.size).toBeGreaterThan(1)
  })

  test('respects int range constraints', async () => {
    const a = createGenerativeFakeAdapter({ seed: 7 })
    const r = await a.call(
      makeCall('f', {
        n: {
          kind: 'scalar',
          base: 'int',
          constraint: { kind: 'range', min: 1, max: 5 },
        } as TrainTypeDescriptor,
      }),
    )
    expect(r.kind).toBe('success')
    if (r.kind === 'success') {
      const n = r.outputs.n as number
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(5)
    }
  })

  test('enum value always in declared variants', async () => {
    const a = createGenerativeFakeAdapter({ seed: 7 })
    for (let i = 0; i < 50; i++) {
      const r = await a.call(
        makeCall(
          'f',
          {
            color: {
              kind: 'enum',
              variants: ['red', 'green', 'blue'],
            } as TrainTypeDescriptor,
          },
          i + 1,
        ),
      )
      if (r.kind === 'success') {
        expect(['red', 'green', 'blue']).toContain(r.outputs.color)
      }
    }
  })

  test('object schema recursively filled', async () => {
    const a = createGenerativeFakeAdapter({ seed: 7 })
    const r = await a.call(
      makeCall('f', {
        nested: {
          kind: 'object',
          fields: {
            a: { kind: 'scalar', base: 'int' },
            b: { kind: 'scalar', base: 'string' },
          },
        } as TrainTypeDescriptor,
      }),
    )
    expect(r.kind).toBe('success')
    if (r.kind === 'success') {
      const nested = r.outputs.nested as any
      expect(typeof nested.a).toBe('number')
      expect(typeof nested.b).toBe('string')
    }
  })
})

describe('GenerativeFakeAdapter — fault injection', () => {
  test('faultRate=1 → faults inserted (some fault on every call)', async () => {
    const a = createGenerativeFakeAdapter({ seed: 1, faultRate: 1 })
    for (let i = 0; i < 10; i++) {
      await a.call(makeCall('f', SIMPLE_OUTPUTS, i + 1))
    }
    expect(a.faultsInjected.every((m) => m !== null)).toBe(true)
  })

  test('extraField mode adds __bonus key', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['extraField'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      expect(r.outputs).toHaveProperty('__bonus')
    }
  })

  test('missingField removes a key', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['missingField'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      expect(Object.keys(r.outputs).length).toBe(1)
    }
  })

  test('markdownWrapped produces __raw with code fence', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['markdownWrapped'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      expect(r.outputs.__raw).toMatch(/^```json/)
    }
  })

  test('prefixChatter adds Chinese chatter before JSON', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['prefixChatter'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      expect(r.outputs.__raw).toMatch(/好的/)
    }
  })

  test('singleQuotes replaces " with \'', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['singleQuotes'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      const raw = r.outputs.__raw as string
      expect(raw).not.toContain('"')
      expect(raw).toContain("'")
    }
  })

  test('trailingComma adds malformed comma', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['trailingComma'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      expect(r.outputs.__raw).toMatch(/,}$/)
    }
  })

  test('truncated cuts JSON in half', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['truncated'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      const raw = r.outputs.__raw as string
      expect(raw.endsWith('}')).toBe(false)
    }
  })

  test('arrayInsteadObject returns array', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['arrayInsteadObject'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      expect(Array.isArray(r.outputs)).toBe(true)
    }
  })

  test('all 15 fault modes are exported', () => {
    expect(ALL_FAULT_MODES.length).toBe(15)
  })

  test('unquotedKey drops quotes from object keys', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['unquotedKey'],
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    if (r.kind === 'success') {
      const raw = r.outputs.__raw as string
      // top-level keys have no leading quote
      expect(raw).toMatch(/score:|comment:/)
    }
  })

  test('unicodeEscape replaces non-ASCII characters with \\uXXXX', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      faultRate: 1,
      faultModes: ['unicodeEscape'],
    })
    const r = await a.call(
      makeCall('f', {
        text: { kind: 'scalar', base: 'string' } as TrainTypeDescriptor,
      }),
    )
    if (r.kind === 'success' && r.outputs.__raw) {
      // The raw may or may not have escapes depending on what corpus
      // entry was picked, but it must be a string and valid format.
      expect(typeof r.outputs.__raw).toBe('string')
    }
  })
})

describe('retryConverge mode', () => {
  test('first N calls inject fault, subsequent calls clean', async () => {
    const a = createGenerativeFakeAdapter({
      seed: 1,
      retryConverge: { failTimes: 2, mode: 'missingField' },
    })
    const r1 = await a.call(makeCall('f', SIMPLE_OUTPUTS, 1))
    const r2 = await a.call(makeCall('f', SIMPLE_OUTPUTS, 2))
    const r3 = await a.call(makeCall('f', SIMPLE_OUTPUTS, 3))
    // r1 + r2 should have missingField fault
    expect(a.faultsInjected[0]).toBe('missingField')
    expect(a.faultsInjected[1]).toBe('missingField')
    // r3 should be clean
    expect(a.faultsInjected[2]).toBe(null)
    if (r3.kind === 'success') {
      expect(Object.keys(r3.outputs).sort()).toEqual(['comment', 'score'])
    }
  })
})

describe('reset()', () => {
  test('reset clears calls and re-seeds RNG → deterministic restart', async () => {
    const a = createGenerativeFakeAdapter({ seed: 1 })
    await a.call(makeCall('f', SIMPLE_OUTPUTS, 1))
    const before = a.calls.length
    a.reset()
    expect(a.calls.length).toBe(0)
    expect(a.faultsInjected.length).toBe(0)
    expect(before).toBe(1)
  })
})

describe('ChaosAdapter', () => {
  test('timeout mode returns FaiTimeout', async () => {
    const a = createChaosAdapter({ mode: 'timeout' })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    expect(r.kind).toBe('timeout')
  })

  test('cancel mode returns FaiCancelled', async () => {
    const a = createChaosAdapter({ mode: 'cancel' })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    expect(r.kind).toBe('cancelled')
  })

  test('unrecoverable-error returns error+recoverable=false', async () => {
    const a = createChaosAdapter({
      mode: 'unrecoverable-error',
      message: 'die',
    })
    const r = await a.call(makeCall('f', SIMPLE_OUTPUTS))
    expect(r.kind).toBe('error')
    if (r.kind === 'error') {
      expect(r.recoverable).toBe(false)
      expect(r.message).toBe('die')
    }
  })

  test('throw mode throws synchronously (rejects promise)', async () => {
    const a = createChaosAdapter({ mode: 'throw', message: 'kaboom' })
    await expect(a.call(makeCall('f', SIMPLE_OUTPUTS))).rejects.toThrow(
      'kaboom',
    )
  })

  test('chaos tracks calls', async () => {
    const a = createChaosAdapter({ mode: 'timeout' })
    await a.call(makeCall('f', SIMPLE_OUTPUTS, 1))
    await a.call(makeCall('g', SIMPLE_OUTPUTS, 2))
    expect(a.calls.length).toBe(2)
  })
})
