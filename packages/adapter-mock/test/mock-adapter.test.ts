import { describe, test, expect } from 'vitest'
import type { FaiCall, FaiResult } from '@tom2012/train-adapter-spec'
import {
  createMockAdapter,
  createReactiveMockAdapter,
  success,
  adapterError,
  timeout,
} from '../src/index.js'

function makeCall(fn: string, callId = 1): FaiCall {
  return {
    callId,
    fnName: fn,
    prompt: `prompt for ${fn}`,
    inputs: {},
    outputs: {
      out: { type: { kind: 'scalar', base: 'string' } },
    },
    options: { timeoutMs: 1000, maxAttempts: 1, attempt: 0 },
  }
}

describe('createMockAdapter — scripted queue', () => {
  test('returns scripted reply in order, unmatched-fn entries are skipped', async () => {
    const adapter = createMockAdapter([
      { fn: 'foo', result: success({ out: 'first' }) },
      { fn: 'bar', result: success({ out: 'second' }) },
    ])
    const r1 = await adapter.call(makeCall('foo'))
    expect(r1).toEqual({ kind: 'success', outputs: { out: 'first' } })
    const r2 = await adapter.call(makeCall('bar'))
    expect(r2).toEqual({ kind: 'success', outputs: { out: 'second' } })
  })

  test('omitted fn (wildcard) matches any name', async () => {
    const adapter = createMockAdapter([
      { result: success({ out: 'any' }) },
    ])
    const r = await adapter.call(makeCall('whatever'))
    expect((r as any).outputs.out).toBe('any')
  })

  test('exhausted queue returns recoverable=false error', async () => {
    const adapter = createMockAdapter([])
    const r = await adapter.call(makeCall('foo'))
    expect(r.kind).toBe('error')
    if (r.kind === 'error') {
      expect(r.recoverable).toBe(false)
      expect(r.message).toContain('mock adapter has no scripted reply')
    }
  })

  test('result can be a function receiving the FaiCall', async () => {
    const adapter = createMockAdapter([
      {
        result: (req) =>
          success({ out: `called-${req.fnName}-#${req.callId}` }),
      },
    ])
    const r = await adapter.call(makeCall('alpha', 7))
    expect((r as any).outputs.out).toBe('called-alpha-#7')
  })

  test('calls array tracks every received FaiCall in order', async () => {
    const adapter = createMockAdapter([
      { result: success({ out: 'x' }) },
      { result: success({ out: 'y' }) },
    ])
    await adapter.call(makeCall('a', 1))
    await adapter.call(makeCall('b', 2))
    expect(adapter.calls.length).toBe(2)
    expect(adapter.calls[0]!.fnName).toBe('a')
    expect(adapter.calls[1]!.callId).toBe(2)
  })

  test('default capabilities: parallel/cancellation true, writesWorkflowData false', () => {
    const adapter = createMockAdapter()
    expect(adapter.capabilities).toEqual({
      parallel: true,
      cancellation: true,
      writesWorkflowData: false,
    })
  })

  test('capability override merges over defaults', () => {
    const adapter = createMockAdapter([], { writesWorkflowData: true })
    expect(adapter.capabilities.writesWorkflowData).toBe(true)
    expect(adapter.capabilities.parallel).toBe(true)
  })

  test('name + version stable', () => {
    const adapter = createMockAdapter()
    expect(adapter.name).toBe('mock')
    expect(adapter.version).toBe('0.0.0')
  })

  test('non-matching named entry skipped, next consumed', async () => {
    const adapter = createMockAdapter([
      { fn: 'wrong', result: success({ out: 'skip' }) },
      { result: success({ out: 'matched' }) },
    ])
    const r = await adapter.call(makeCall('right'))
    expect((r as any).outputs.out).toBe('matched')
  })
})

describe('createReactiveMockAdapter — callback', () => {
  test('callback receives every call, can produce dynamic FaiResult', async () => {
    const adapter = createReactiveMockAdapter((req): FaiResult => {
      return success({ out: `dyn-${req.fnName}` })
    })
    const r = await adapter.call(makeCall('zeta'))
    expect((r as any).outputs.out).toBe('dyn-zeta')
  })

  test('async callback awaited', async () => {
    const adapter = createReactiveMockAdapter(async (): Promise<FaiResult> => {
      await new Promise((r) => setTimeout(r, 5))
      return success({ out: 'async' })
    })
    const r = await adapter.call(makeCall('a'))
    expect((r as any).outputs.out).toBe('async')
  })

  test('reactive adapter name is mock-reactive', () => {
    const adapter = createReactiveMockAdapter(() => success({}))
    expect(adapter.name).toBe('mock-reactive')
  })

  test('reactive adapter also tracks calls', async () => {
    const adapter = createReactiveMockAdapter(() => success({}))
    await adapter.call(makeCall('a'))
    await adapter.call(makeCall('b'))
    expect(adapter.calls.length).toBe(2)
  })
})

describe('convenience constructors', () => {
  test('success() returns FaiSuccess shape', () => {
    expect(success({ k: 1 })).toEqual({ kind: 'success', outputs: { k: 1 } })
  })

  test('adapterError() default not recoverable', () => {
    expect(adapterError('boom')).toEqual({
      kind: 'error',
      message: 'boom',
      recoverable: false,
    })
  })

  test('adapterError() recoverable=true', () => {
    expect(adapterError('flaky', true).recoverable).toBe(true)
  })

  test('timeout() returns FaiTimeout', () => {
    expect(timeout()).toEqual({ kind: 'timeout' })
  })
})
