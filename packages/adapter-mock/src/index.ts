/**
 * @train-lang/adapter-mock — deterministic LLM adapter for testing.
 *
 * No HTTP, no subprocess, no LLM. Used in two flavors:
 *
 *   1. createMockAdapter(scriptedReplies) — return canned outputs
 *      keyed by the fai function name. Each call advances through the
 *      array; if exhausted, fails with a clear error.
 *
 *   2. createReactiveMockAdapter(callback) — for each FaiCall, the
 *      user-supplied callback returns the FaiResult. The callback may
 *      inspect prompt/inputs and assert on them.
 *
 * Both flavors fully satisfy LLMAdapter (capabilities: parallel=true,
 * cancellation=true, writesWorkflowData=false). They are the default
 * test fixture for the interpreter's fai code path.
 */

import type {
  LLMAdapter,
  FaiCall,
  FaiResult,
  AdapterCapabilities,
} from '@train-lang/adapter-spec'

export interface ScriptEntry {
  fn?: string // optional filter by fai name (if absent, matches any)
  result: FaiResult | ((req: FaiCall) => FaiResult)
}

export interface ScriptedMockAdapter extends LLMAdapter {
  /** Calls received so far, in order. Useful for assertions in tests. */
  readonly calls: ReadonlyArray<FaiCall>
}

const DEFAULT_CAPS: AdapterCapabilities = {
  parallel: true,
  cancellation: true,
  writesWorkflowData: false,
}

/**
 * Build a mock adapter from a list of scripted replies. Each fai call
 * consumes the next matching script entry (matching is by fn name, or
 * by position if `fn` is omitted on the entry).
 */
export function createMockAdapter(
  script: ScriptEntry[] = [],
  capabilities: Partial<AdapterCapabilities> = {},
): ScriptedMockAdapter {
  const calls: FaiCall[] = []
  let cursor = 0

  const caps: AdapterCapabilities = { ...DEFAULT_CAPS, ...capabilities }

  return {
    name: 'mock',
    version: '0.0.0',
    capabilities: caps,
    get calls() {
      return calls
    },
    async call(req: FaiCall): Promise<FaiResult> {
      calls.push(req)

      // Find next script entry (by name match, or first un-named entry)
      while (cursor < script.length) {
        const entry = script[cursor]!
        cursor++
        if (entry.fn === undefined || entry.fn === req.fnName) {
          return typeof entry.result === 'function'
            ? entry.result(req)
            : entry.result
        }
        // wrong name — skip this entry and try next
      }

      // No more scripted replies
      return {
        kind: 'error',
        message: `mock adapter has no scripted reply for fai '${req.fnName}' (call #${calls.length}); add one to the script`,
        recoverable: false,
      }
    },
  } satisfies ScriptedMockAdapter
}

/**
 * Build a mock adapter that delegates each call to a user-supplied
 * function. Useful for tests that need to assert on each FaiCall
 * received or produce dynamic outputs.
 */
export function createReactiveMockAdapter(
  handler: (req: FaiCall) => FaiResult | Promise<FaiResult>,
  capabilities: Partial<AdapterCapabilities> = {},
): ScriptedMockAdapter {
  const calls: FaiCall[] = []
  const caps: AdapterCapabilities = { ...DEFAULT_CAPS, ...capabilities }

  return {
    name: 'mock-reactive',
    version: '0.0.0',
    capabilities: caps,
    get calls() {
      return calls
    },
    async call(req: FaiCall): Promise<FaiResult> {
      calls.push(req)
      return await handler(req)
    },
  } satisfies ScriptedMockAdapter
}

/** Convenience: a successful FaiResult with the given outputs. */
export function success(outputs: Record<string, unknown>): FaiResult {
  return { kind: 'success', outputs }
}

/** Convenience: an adapter-level error. */
export function adapterError(message: string, recoverable = false): FaiResult {
  return { kind: 'error', message, recoverable }
}

/** Convenience: a timeout. */
export function timeout(): FaiResult {
  return { kind: 'timeout' }
}
