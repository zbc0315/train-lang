/**
 * @tom2012/train-adapter-fake-gen — Generative + Chaos fake LLM adapters.
 *
 * Layer 3 (Generative) and Layer 4 (Chaos) of the 5-layer fake LLM
 * stack documented in `工作流DSL测试方案.md` §6.
 *
 * Unlike adapter-mock (Layer 1, scripted) and adapter-mock-reactive
 * (Layer 2, callback-driven), this package generates fake data that
 * follows the FaiCall.outputs type schema, optionally injecting
 * realistic LLM-like flaws (missing fields, wrong types, JSON wrapped
 * in markdown, etc.).
 *
 * Determinism: every behavior is keyed by a numeric seed. Two
 * GenerativeFakeAdapter instances with the same seed + same FaiCall
 * sequence produce identical outputs.
 */

import type {
  LLMAdapter,
  FaiCall,
  FaiResult,
  TrainTypeDescriptor,
  AdapterCapabilities,
} from '@tom2012/train-adapter-spec'

// ─── Deterministic RNG ────────────────────────────────────────────────

class Rng {
  private state: number
  constructor(seed: number) {
    // mulberry32 — fast deterministic PRNG, good enough for fixtures
    this.state = (seed >>> 0) || 0xdeadbeef
  }
  next(): number {
    let t = (this.state += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)]!
  }
}

// ─── Lorem ipsum-style corpus for `string` / `prompt` types ──────────

const STRING_CORPUS = [
  'lorem ipsum',
  'fake response',
  'sample value',
  'placeholder',
  'mock output',
  '示例文本',
  'résumé',
  '42 entries',
  'TBD',
  'pending review',
]

// ─── Fault injection modes ───────────────────────────────────────────

export type FaultMode =
  | 'extraField'
  | 'missingField'
  | 'wrongType'
  | 'enumOutOfRange'
  | 'markdownWrapped'
  | 'prefixChatter'
  | 'suffixChatter'
  | 'singleQuotes'
  | 'unquotedKey'
  | 'trailingComma'
  | 'truncated'
  | 'nullForNonNull'
  | 'numericString'
  | 'arrayInsteadObject'
  | 'unicodeEscape'

const ALL_FAULT_MODES: FaultMode[] = [
  'extraField',
  'missingField',
  'wrongType',
  'enumOutOfRange',
  'markdownWrapped',
  'prefixChatter',
  'suffixChatter',
  'singleQuotes',
  'unquotedKey',
  'trailingComma',
  'truncated',
  'nullForNonNull',
  'numericString',
  'arrayInsteadObject',
  'unicodeEscape',
]

// ─── Generator: build a legal value for a given type ────────────────

function generateValueFor(
  type: TrainTypeDescriptor,
  rng: Rng,
): unknown {
  switch (type.kind) {
    case 'scalar':
      return generateScalar(type.base, type.constraint as unknown, rng)
    case 'enum':
      return rng.pick(type.variants)
    case 'array': {
      const len = rng.int(0, 3)
      const out: unknown[] = []
      for (let i = 0; i < len; i++) out.push(generateValueFor(type.element, rng))
      return out
    }
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(type.fields)) {
        out[k] = generateValueFor(v, rng)
      }
      return out
    }
  }
}

function generateScalar(
  base: string,
  constraint: unknown,
  rng: Rng,
): unknown {
  switch (base) {
    case 'int':
      if (constraint && (constraint as any).kind === 'range') {
        return rng.int(
          (constraint as any).min ?? 0,
          (constraint as any).max ?? 100,
        )
      }
      return rng.int(0, 100)
    case 'float':
      return Math.round(rng.next() * 10000) / 100
    case 'bool':
      return rng.next() < 0.5
    case 'string':
    case 'prompt':
      return rng.pick(STRING_CORPUS)
    case 'any':
      return rng.pick(STRING_CORPUS)
    default:
      return rng.pick(STRING_CORPUS)
  }
}

// ─── Fault injection: take a legal output object and break it ─────────

function injectFault(
  outputs: Record<string, unknown>,
  outputsSchema: Record<string, { type: TrainTypeDescriptor }>,
  mode: FaultMode,
  rng: Rng,
): { value: Record<string, unknown> | string; serializeAsString: boolean } {
  const keys = Object.keys(outputs)
  switch (mode) {
    case 'extraField':
      return {
        value: { ...outputs, __bonus: 'extra-field-from-fake-gen' },
        serializeAsString: false,
      }
    case 'missingField': {
      if (keys.length === 0) return { value: outputs, serializeAsString: false }
      const k = rng.pick(keys)
      const v = { ...outputs }
      delete v[k]
      return { value: v, serializeAsString: false }
    }
    case 'wrongType': {
      if (keys.length === 0) return { value: outputs, serializeAsString: false }
      const k = rng.pick(keys)
      const v = { ...outputs }
      // swap to string regardless of original type
      v[k] = `wrong-type-string-${String(v[k])}`
      return { value: v, serializeAsString: false }
    }
    case 'enumOutOfRange': {
      // find an enum field and break it
      for (const k of keys) {
        const t = outputsSchema[k]?.type
        if (t?.kind === 'enum') {
          const v = { ...outputs }
          v[k] = 'NOT_A_LEGAL_ENUM_VALUE'
          return { value: v, serializeAsString: false }
        }
      }
      return { value: outputs, serializeAsString: false }
    }
    case 'markdownWrapped':
      return {
        value: '```json\n' + JSON.stringify(outputs) + '\n```',
        serializeAsString: true,
      }
    case 'prefixChatter':
      return {
        value: '好的，这是结果：\n' + JSON.stringify(outputs),
        serializeAsString: true,
      }
    case 'suffixChatter':
      return {
        value: JSON.stringify(outputs) + '\n以上，希望能帮到你。',
        serializeAsString: true,
      }
    case 'singleQuotes':
      return {
        value: JSON.stringify(outputs).replace(/"/g, "'"),
        serializeAsString: true,
      }
    case 'unquotedKey': {
      // Drop quotes around top-level object keys (JS object literal style).
      // Naive — works for simple flat objects only.
      const s = JSON.stringify(outputs)
      const unquoted = s.replace(/"(\w+)":/g, '$1:')
      return { value: unquoted, serializeAsString: true }
    }
    case 'unicodeEscape': {
      // \u escape every char that has codepoint > 0x7f
      const s = JSON.stringify(outputs)
      const escaped = s.replace(/[-￿]/g, (c) => {
        const hex = c.charCodeAt(0).toString(16).padStart(4, '0')
        return '\\u' + hex
      })
      return { value: escaped, serializeAsString: true }
    }
    case 'trailingComma': {
      const s = JSON.stringify(outputs)
      // insert trailing comma after last value before closing brace
      return {
        value: s.replace(/}$/, ',}'),
        serializeAsString: true,
      }
    }
    case 'truncated': {
      const s = JSON.stringify(outputs)
      return {
        value: s.slice(0, Math.max(2, Math.floor(s.length / 2))),
        serializeAsString: true,
      }
    }
    case 'nullForNonNull': {
      if (keys.length === 0) return { value: outputs, serializeAsString: false }
      const k = rng.pick(keys)
      const v = { ...outputs, [k]: null }
      return { value: v, serializeAsString: false }
    }
    case 'numericString': {
      if (keys.length === 0) return { value: outputs, serializeAsString: false }
      const k = rng.pick(keys)
      const t = outputsSchema[k]?.type
      if (
        t?.kind === 'scalar' &&
        (t.base === 'int' || t.base === 'float')
      ) {
        const v = { ...outputs, [k]: String(outputs[k]) }
        return { value: v, serializeAsString: false }
      }
      return { value: outputs, serializeAsString: false }
    }
    case 'arrayInsteadObject':
      return { value: Object.values(outputs) as any, serializeAsString: false }
  }
}

// ─── Generative adapter ──────────────────────────────────────────────

export interface GenerativeFakeOptions {
  seed?: number
  /**
   * Per-call probability of fault injection. 0 = always clean. 1 =
   * always faulted. Default 0.
   */
  faultRate?: number
  /**
   * Restrict fault types. Default: all known FaultMode values.
   */
  faultModes?: FaultMode[]
  /**
   * Force a specific failure mode for the first N calls, then return
   * clean output. Useful for retry-convergence tests.
   *
   *   retryConverge: { failTimes: 2, mode: "missingField" }
   *
   * → calls 0 and 1 inject `missingField`; call 2+ is clean.
   */
  retryConverge?: { failTimes: number; mode: FaultMode }
  capabilities?: Partial<AdapterCapabilities>
}

export interface GenerativeFakeAdapter extends LLMAdapter {
  readonly calls: ReadonlyArray<FaiCall>
  readonly faultsInjected: ReadonlyArray<FaultMode | null>
  reset(): void
}

const DEFAULT_CAPS: AdapterCapabilities = {
  parallel: true,
  cancellation: true,
  writesWorkflowData: false,
}

export function createGenerativeFakeAdapter(
  opts: GenerativeFakeOptions = {},
): GenerativeFakeAdapter {
  const seed = opts.seed ?? 42
  const faultRate = opts.faultRate ?? 0
  const faultModes = opts.faultModes ?? ALL_FAULT_MODES
  const retryConverge = opts.retryConverge
  const caps: AdapterCapabilities = { ...DEFAULT_CAPS, ...opts.capabilities }

  let rng = new Rng(seed)
  const calls: FaiCall[] = []
  const faultsInjected: (FaultMode | null)[] = []

  return {
    name: 'fake-gen',
    version: '0.0.0',
    capabilities: caps,
    get calls() {
      return calls
    },
    get faultsInjected() {
      return faultsInjected
    },
    reset() {
      rng = new Rng(seed)
      calls.length = 0
      faultsInjected.length = 0
    },
    async call(req: FaiCall): Promise<FaiResult> {
      calls.push(req)

      // 1. Generate a legal output object matching schema
      const cleanOutputs: Record<string, unknown> = {}
      for (const [k, spec] of Object.entries(req.outputs)) {
        cleanOutputs[k] = generateValueFor(spec.type, rng)
      }

      // 2. Decide whether to inject a fault
      let mode: FaultMode | null = null
      const callIdx = calls.length - 1
      if (retryConverge && callIdx < retryConverge.failTimes) {
        mode = retryConverge.mode
      } else if (faultRate > 0 && rng.next() < faultRate) {
        mode = rng.pick(faultModes)
      }
      faultsInjected.push(mode)

      // 3. If no fault, return clean success
      if (!mode) {
        return { kind: 'success', outputs: cleanOutputs }
      }

      // 4. Inject fault. If the fault produces a string (e.g. markdown
      //    wrapped JSON), return as a single string output that the
      //    adapter contract treats as a free-form result. For now we
      //    return it as `kind: 'success'` with the broken outputs;
      //    upstream validation will catch the shape mismatch and
      //    surface a validation-error result.
      const faulted = injectFault(cleanOutputs, req.outputs, mode, rng)
      if (faulted.serializeAsString) {
        // Wrap the broken JSON string in a single "rawText" key so the
        // upstream validator sees the schema mismatch and reports it.
        return {
          kind: 'success',
          outputs: { __raw: faulted.value as string },
        }
      }
      return {
        kind: 'success',
        outputs: faulted.value as Record<string, unknown>,
      }
    },
  }
}

// ─── Chaos adapter ───────────────────────────────────────────────────

export interface ChaosOptions {
  mode: 'timeout' | 'throw' | 'cancel' | 'unrecoverable-error'
  message?: string
  capabilities?: Partial<AdapterCapabilities>
}

export interface ChaosAdapter extends LLMAdapter {
  readonly calls: ReadonlyArray<FaiCall>
}

export function createChaosAdapter(opts: ChaosOptions): ChaosAdapter {
  const calls: FaiCall[] = []
  const caps: AdapterCapabilities = { ...DEFAULT_CAPS, ...opts.capabilities }
  return {
    name: 'chaos',
    version: '0.0.0',
    capabilities: caps,
    get calls() {
      return calls
    },
    async call(req: FaiCall): Promise<FaiResult> {
      calls.push(req)
      switch (opts.mode) {
        case 'timeout':
          return { kind: 'timeout' }
        case 'cancel':
          return { kind: 'cancelled' }
        case 'unrecoverable-error':
          return {
            kind: 'error',
            message: opts.message ?? 'chaos: unrecoverable',
            recoverable: false,
          }
        case 'throw':
          throw new Error(opts.message ?? 'chaos: synthetic throw')
      }
    },
  }
}

export { ALL_FAULT_MODES }
