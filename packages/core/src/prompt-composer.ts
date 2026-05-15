/**
 * Compose the full LLM prompt for one fai function call.
 *
 * Default composition layout (spec §3.6):
 *
 *   [System]      Short instruction header.
 *   [Inputs]      Each non-prompt-typed parameter with name(description, type) = value
 *   [Task]        Concatenation of all prompt-typed parameters.
 *   [Outputs]     Each declared output with name(description, type) and the
 *                 wire format the adapter expects (JSON object).
 *   [Adapter hint] Either "JSON object" (direct API) or "modify
 *                 .ccweb/workflow_data.json" (agent CLI), depending on
 *                 the adapter's capabilities.writesWorkflowData flag.
 *
 * Short scalar/bool/number values are formatted inline; arrays/objects
 * and multi-line strings are formatted as fenced blocks.
 *
 * No special handling for `fai` body — the M1 parser already collected
 * the body block (currently empty in 99% of cases). If we add a future
 * "body can compute a custom prompt" feature, this composer will read
 * a `prompt = ...` assignment from the body before defaulting.
 */

import type * as ast from './ast.js'
import type { Value } from './runtime.js'
import type {
  AdapterCapabilities,
  FaiInputSpec,
  FaiOutputSpec,
} from '@tom2012/train-adapter-spec'
import { describeType, isPromptType, typeToDescriptor } from './type-descriptor.js'
import { formatValue } from './builtins.js'

export interface ComposedPrompt {
  text: string
  inputs: Record<string, FaiInputSpec>
  outputs: Record<string, FaiOutputSpec>
}

export interface ComposeOptions {
  capabilities: AdapterCapabilities
  /** Adapter context for the writesWorkflowData hint. */
  callId?: number
  /**
   * Override the final "how to write outputs" hint. If provided, this
   * string replaces both the default direct-API ("Respond with JSON ...")
   * hint and the default agent-CLI hint. Hosts that have their own PTY
   * protocol (e.g. ccweb's `variables` + `task_progress.finish` scheme)
   * pass their own protocol text here. The composer still emits the
   * [System] / [Inputs] / [Task] / [Outputs] sections unchanged.
   *
   * The string is appended as a final section verbatim — no quoting,
   * no template interpolation.
   */
  writeProtocolHint?: string
}

export function composePrompt(
  decl: ast.FaiDecl,
  argValues: Map<string, Value>,
  opts: ComposeOptions,
): ComposedPrompt {
  // Partition params into data inputs vs prompt segments
  const inputs: Record<string, FaiInputSpec> = {}
  const promptSegments: string[] = []
  const inputLines: string[] = []

  for (const p of decl.params) {
    const v = argValues.get(p.name) ?? null
    if (isPromptType(p.type)) {
      // prompt-typed param goes into the [Task] section
      promptSegments.push(formatPromptParam(v))
    } else {
      inputs[p.name] = {
        type: typeToDescriptor(p.type),
        value: valueToJson(v),
      }
      inputLines.push(formatInputLine(p.name, p.type, v))
    }
  }

  // Outputs schema
  const outputs: Record<string, FaiOutputSpec> = {}
  const outputLines: string[] = []
  for (const o of decl.outputs) {
    outputs[o.name] = {
      type: typeToDescriptor(o.type),
    }
    outputLines.push(`  ${o.name}: ${describeType(typeToDescriptor(o.type))}`)
  }

  // Assemble final text
  const sections: string[] = []
  sections.push(
    `You are executing the train language fai function \`${decl.name}\`. Follow the task instructions and produce the required outputs.`,
  )

  if (inputLines.length > 0) {
    sections.push('[Inputs]\n' + inputLines.join('\n'))
  }

  if (promptSegments.length > 0) {
    sections.push('[Task]\n' + promptSegments.join('\n\n'))
  }

  sections.push(
    '[Required outputs — each value must match the declared type]\n' +
      outputLines.join('\n'),
  )

  if (opts.writeProtocolHint !== undefined) {
    // Host-provided protocol overrides built-in defaults entirely.
    sections.push(opts.writeProtocolHint)
  } else if (opts.capabilities.writesWorkflowData) {
    sections.push(
      `[Write outputs by modifying \`.ccweb/workflow_data.json\` at ` +
        `stack[<callId>].outputs.<name>, then set ` +
        `task_progress[N].finish = true.]`,
    )
  } else {
    sections.push(
      `[Respond with ONLY a JSON object whose keys are exactly the output ` +
        `names above and whose values match the declared types. ` +
        `Do not include any explanation, markdown fences, or extra prose ` +
        `outside the JSON.]`,
    )
  }

  return {
    text: sections.join('\n\n'),
    inputs,
    outputs,
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function formatPromptParam(v: Value): string {
  // prompt-typed values are strings (or stringified). No quoting; the
  // user's prompt text becomes part of the system task description.
  if (typeof v === 'string') return v
  return formatValue(v)
}

function formatInputLine(
  name: string,
  type: ast.TypeAnnot,
  value: Value,
): string {
  const typeStr = describeType(typeToDescriptor(type))
  if (isInlineable(value)) {
    return `  ${name}(${typeStr}) = ${formatInlineValue(value)}`
  }
  // Block form
  const valueStr = formatBlockValue(value)
  return `  ${name}(${typeStr}):\n${indent(valueStr, 4)}`
}

function isInlineable(v: Value): boolean {
  if (v === null) return true
  if (typeof v === 'boolean') return true
  if (typeof v === 'number') return true
  if (typeof v === 'string') return v.length < 80 && !v.includes('\n')
  return false
}

function formatInlineValue(v: Value): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return JSON.stringify(v)
  return formatValue(v)
}

function formatBlockValue(v: Value): string {
  if (typeof v === 'string') {
    return '"""\n' + v + '\n"""'
  }
  return JSON.stringify(v, null, 2)
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n)
  return s.split('\n').map((l) => pad + l).join('\n')
}

/** Convert a runtime Value into a JSON-friendly object for adapters. */
function valueToJson(v: Value): unknown {
  if (v === null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map((x) => valueToJson(x))
  if (typeof v === 'object') {
    // Skip function/builtin values (shouldn't appear in fai input args anyway)
    if ('__kind' in (v as object)) {
      return null
    }
    const o = v as { [k: string]: Value }
    const out: { [k: string]: unknown } = {}
    for (const k of Object.keys(o)) out[k] = valueToJson(o[k]!)
    return out
  }
  return null
}
