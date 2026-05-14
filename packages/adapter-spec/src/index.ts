/**
 * @train-lang/adapter-spec — LLM adapter protocol for train.
 *
 * This package contains ONLY TypeScript type definitions; it has zero
 * runtime dependencies. Every LLM adapter (OpenAI / Anthropic / Ollama /
 * Claude Code / Codex / ccweb / etc.) implements the interfaces here.
 *
 * train's core (@train-lang/core) depends on this package and dispatches
 * fai function calls through whatever LLMAdapter is configured at run
 * time. Core itself never makes HTTP requests or spawns processes.
 */

// ─── Type system descriptors ────────────────────────────────────────────

/**
 * A runtime-friendly description of a train type. The core sends this
 * to adapters so they can build structured-output schemas (e.g. JSON
 * mode for OpenAI / Anthropic) and so they can validate responses.
 */
export type TrainTypeDescriptor =
  | ScalarTypeDescriptor
  | EnumTypeDescriptor
  | ArrayTypeDescriptor
  | ObjectTypeDescriptor

export interface ScalarTypeDescriptor {
  kind: 'scalar'
  /** int / float / bool / string / prompt / any */
  base: string
  constraint?: TypeConstraintDescriptor
}

export type TypeConstraintDescriptor =
  | { kind: 'range'; min: number; max: number }
  | { kind: 'named'; key: string; value: number | string }

export interface EnumTypeDescriptor {
  kind: 'enum'
  variants: string[]
}

export interface ArrayTypeDescriptor {
  kind: 'array'
  element: TrainTypeDescriptor
  constraint?: TypeConstraintDescriptor
}

export interface ObjectTypeDescriptor {
  kind: 'object'
  fields: Record<string, TrainTypeDescriptor>
}

// ─── FaiCall request ────────────────────────────────────────────────────

export interface FaiInputSpec {
  type: TrainTypeDescriptor
  /** Already JSON-friendly (numbers/strings/booleans/arrays/objects). */
  value: unknown
  description?: string
}

export interface FaiOutputSpec {
  type: TrainTypeDescriptor
  description?: string
}

export interface FaiCallOptions {
  /** Hard timeout per attempt. Adapter should reject with `timeout`. */
  timeoutMs: number
  /** Max number of total attempts (initial + retries). 1 = no retry. */
  maxAttempts: number
  /** Which attempt this is (0 = first call; 1+ = retry-with-feedback). */
  attempt: number
  /** Adapter-specific model identifier (e.g. "gpt-4o", "claude-sonnet-4-6"). */
  model?: string
  /** Optional AbortSignal — if supported, adapter should cancel on abort. */
  signal?: AbortSignal
}

/**
 * One LLM call corresponding to one fai function invocation.
 *
 * The `prompt` field is the already-composed full prompt text. The
 * `inputs` / `outputs` maps carry the structural information so an
 * adapter using JSON-mode / structured output / function calling can
 * derive a strict schema without having to re-parse `prompt`.
 */
export interface FaiCall {
  /** Monotonic id within a run (used in trace, debugging). */
  callId: number
  /** The source-level name of the fai function being invoked. */
  fnName: string
  /** Fully composed prompt text. */
  prompt: string
  /** Structured input parameters (excluding prompt-typed params). */
  inputs: Record<string, FaiInputSpec>
  /** Required output schema (1+ entries). */
  outputs: Record<string, FaiOutputSpec>
  options: FaiCallOptions
}

// ─── FaiCall response ───────────────────────────────────────────────────

export type FaiResult =
  | FaiSuccess
  | FaiValidationError
  | FaiTimeout
  | FaiCancelled
  | FaiAdapterError

export interface FaiSuccess {
  kind: 'success'
  /** JSON-friendly values matching the declared output schema. */
  outputs: Record<string, unknown>
  /** Optional metadata (token counts, latency, etc.) for trace logs. */
  meta?: Record<string, unknown>
}

export interface FaiValidationError {
  kind: 'validation-error'
  errors: ValidationErrorItem[]
  /** Raw outputs as produced by the LLM, for debugging. */
  rawOutputs?: Record<string, unknown>
}

export interface ValidationErrorItem {
  outputName: string
  message: string
  expected: TrainTypeDescriptor
  actual?: unknown
}

export interface FaiTimeout {
  kind: 'timeout'
}

export interface FaiCancelled {
  kind: 'cancelled'
}

export interface FaiAdapterError {
  kind: 'error'
  message: string
  /** If true, the runtime may retry once. If false, propagate immediately. */
  recoverable: boolean
}

// ─── Adapter capabilities ──────────────────────────────────────────────

export interface AdapterCapabilities {
  /** Adapter is safe to invoke from multiple concurrent fai calls. */
  parallel: boolean
  /** Adapter honors FaiCallOptions.signal abortion. */
  cancellation: boolean
  /**
   * Two paradigms supported by train:
   *  - false: "direct API" — adapter returns outputs in FaiSuccess.outputs.
   *           Core writes them into workflow_data.json.
   *  - true:  "agent CLI"  — adapter coordinates with an external agent
   *           that writes outputs directly to a file shared with core.
   *           Core trusts the file contents post-call.
   */
  writesWorkflowData: boolean
}

// ─── Adapter interface ─────────────────────────────────────────────────

export interface LLMAdapter {
  /** Stable identifier (e.g. "openai", "anthropic", "claude-code", "mock"). */
  readonly name: string
  /** Semver string of this adapter implementation. */
  readonly version: string
  readonly capabilities: AdapterCapabilities

  /**
   * Perform one fai call. The runtime constructs FaiCall, dispatches to
   * `call`, awaits the result, validates it (if `writesWorkflowData` is
   * false) or trusts the file (if true), and may invoke again with an
   * incremented `attempt` if validation fails.
   */
  call(req: FaiCall): Promise<FaiResult>

  /**
   * Optional preflight check at adapter registration time. Adapters that
   * need API keys / network reachability / spawned subprocess should
   * implement this so the runtime can fail fast.
   */
  healthCheck?(): Promise<{ ok: boolean; message?: string }>

  /**
   * Optional cleanup hook called when a run ends. Adapters that hold
   * connections / subprocess handles can release them here.
   */
  close?(): Promise<void>
}
