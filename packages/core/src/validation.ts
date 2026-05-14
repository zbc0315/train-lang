/**
 * Runtime validation of fai outputs against their declared schema.
 *
 * Used by the interpreter's fai-call path. If an adapter returns
 * `kind: 'success'`, the runtime validates the payload here before
 * accepting it; mismatches trigger a retry-with-feedback (composing
 * a new prompt that itemizes what went wrong).
 *
 * Adapters with `capabilities.writesWorkflowData = true` (agent CLI)
 * write directly to the project's workflow_data.json; the runtime
 * still re-reads and revalidates so adapter trust isn't unbounded.
 */

import type * as ast from './ast.js'
import { describeType, typeToDescriptor } from './type-descriptor.js'
import type {
  TrainTypeDescriptor,
  ValidationErrorItem,
} from '@train-lang/adapter-spec'
import type { Value } from './runtime.js'

export type ValidateValueResult =
  | { ok: true; value: Value }
  | { ok: false; message: string }

export type ValidateOutputsResult =
  | { ok: true; outputs: Record<string, Value> }
  | { ok: false; errors: ValidationErrorItem[] }

/**
 * Validate a map of raw outputs (as produced by an adapter) against the
 * declared FaiOutput list. Returns either {ok:true, outputs} or
 * {ok:false, errors} suitable for feeding back into a retry prompt.
 */
export function validateOutputs(
  outputDecls: ReadonlyArray<ast.FaiOutput>,
  raw: Record<string, unknown>,
): ValidateOutputsResult {
  const validated: Record<string, Value> = {}
  const errors: ValidationErrorItem[] = []

  // 1. Each declared output must be present and valid
  for (const decl of outputDecls) {
    const desc = typeToDescriptor(decl.type)
    if (!(decl.name in raw)) {
      errors.push({
        outputName: decl.name,
        message: `missing required output '${decl.name}'`,
        expected: desc,
      })
      continue
    }
    const r = validateValue(raw[decl.name], decl.type)
    if (r.ok) {
      validated[decl.name] = r.value
    } else {
      errors.push({
        outputName: decl.name,
        message: r.message,
        expected: desc,
        actual: raw[decl.name],
      })
    }
  }

  // 2. Surplus keys are a soft signal — record as a warning-style error
  for (const key of Object.keys(raw)) {
    if (!outputDecls.some((d) => d.name === key)) {
      errors.push({
        outputName: key,
        message: `unexpected output key '${key}' (not declared)`,
        expected: { kind: 'scalar', base: 'never' } as TrainTypeDescriptor,
        actual: raw[key],
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, outputs: validated }
}

/** Validate a single value against a type annotation. */
export function validateValue(
  v: unknown,
  type: ast.TypeAnnot,
): ValidateValueResult {
  switch (type.kind) {
    case 'ScalarType':
      return validateScalar(v, type)
    case 'EnumType':
      if (typeof v !== 'string')
        return {
          ok: false,
          message: `expected enum string, got ${typeNameOf(v)}`,
        }
      if (!type.variants.includes(v))
        return {
          ok: false,
          message: `enum value "${v}" not in [${type.variants.join('|')}]`,
        }
      return { ok: true, value: v }
    case 'ArrayType':
      return validateArray(v, type)
    case 'ObjectType':
      return validateObject(v, type)
  }
}

function validateScalar(
  v: unknown,
  type: ast.ScalarType,
): ValidateValueResult {
  switch (type.name) {
    case 'any':
      return { ok: true, value: v as Value }
    case 'int':
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v))
        return {
          ok: false,
          message: `expected int, got ${typeNameOf(v)} (${formatActual(v)})`,
        }
      return applyScalarConstraint(v, type, v)
    case 'float':
      if (typeof v !== 'number' || !Number.isFinite(v))
        return {
          ok: false,
          message: `expected float, got ${typeNameOf(v)} (${formatActual(v)})`,
        }
      return applyScalarConstraint(v, type, v)
    case 'bool':
      if (typeof v !== 'boolean')
        return {
          ok: false,
          message: `expected bool, got ${typeNameOf(v)}`,
        }
      return { ok: true, value: v }
    case 'string':
    case 'prompt':
      if (typeof v !== 'string')
        return {
          ok: false,
          message: `expected string, got ${typeNameOf(v)}`,
        }
      return applyStringConstraint(v, type)
    default:
      // Unknown scalar type name — type checker should have caught.
      return {
        ok: false,
        message: `unknown type '${type.name}'`,
      }
  }
}

function applyScalarConstraint(
  v: number,
  type: ast.ScalarType,
  out: Value,
): ValidateValueResult {
  if (!type.constraint) return { ok: true, value: out }
  if (type.constraint.kind === 'RangeConstraint') {
    if (v < type.constraint.min || v > type.constraint.max) {
      return {
        ok: false,
        message: `value ${v} out of range ${type.constraint.min}-${type.constraint.max}`,
      }
    }
  } else {
    const c = type.constraint
    if (c.key === 'min' && typeof c.value === 'number' && v < c.value)
      return { ok: false, message: `value ${v} < min=${c.value}` }
    if (c.key === 'max' && typeof c.value === 'number' && v > c.value)
      return { ok: false, message: `value ${v} > max=${c.value}` }
  }
  return { ok: true, value: out }
}

function applyStringConstraint(
  v: string,
  type: ast.ScalarType,
): ValidateValueResult {
  if (!type.constraint) return { ok: true, value: v }
  if (type.constraint.kind === 'NamedConstraint') {
    const c = type.constraint
    if (c.key === 'maxLen' && typeof c.value === 'number') {
      const len = [...v].length
      if (len > c.value)
        return {
          ok: false,
          message: `string length ${len} > maxLen=${c.value}`,
        }
    }
    if (c.key === 'minLen' && typeof c.value === 'number') {
      const len = [...v].length
      if (len < c.value)
        return {
          ok: false,
          message: `string length ${len} < minLen=${c.value}`,
        }
    }
    if (c.key === 'matches' && typeof c.value === 'string') {
      try {
        if (!new RegExp(c.value).test(v))
          return {
            ok: false,
            message: `string does not match /${c.value}/`,
          }
      } catch {
        return {
          ok: false,
          message: `constraint regex /${c.value}/ is not a valid pattern`,
        }
      }
    }
  }
  return { ok: true, value: v }
}

function validateArray(
  v: unknown,
  type: ast.ArrayType,
): ValidateValueResult {
  if (!Array.isArray(v))
    return { ok: false, message: `expected array, got ${typeNameOf(v)}` }
  const elements: Value[] = []
  for (let i = 0; i < v.length; i++) {
    const r = validateValue(v[i], type.element)
    if (!r.ok) {
      return {
        ok: false,
        message: `array[${i}]: ${r.message}`,
      }
    }
    elements.push(r.value)
  }
  if (type.constraint && type.constraint.kind === 'NamedConstraint') {
    const c = type.constraint
    if (c.key === 'minLen' && typeof c.value === 'number' && elements.length < c.value)
      return {
        ok: false,
        message: `array length ${elements.length} < minLen=${c.value}`,
      }
    if (c.key === 'maxLen' && typeof c.value === 'number' && elements.length > c.value)
      return {
        ok: false,
        message: `array length ${elements.length} > maxLen=${c.value}`,
      }
  }
  return { ok: true, value: elements }
}

function validateObject(
  v: unknown,
  type: ast.ObjectType,
): ValidateValueResult {
  if (
    v === null ||
    typeof v !== 'object' ||
    Array.isArray(v)
  )
    return { ok: false, message: `expected object, got ${typeNameOf(v)}` }
  const obj = v as { [k: string]: unknown }
  const out: { [k: string]: Value } = {}
  for (const f of type.fields) {
    if (!(f.name in obj))
      return {
        ok: false,
        message: `object missing field '${f.name}'`,
      }
    const r = validateValue(obj[f.name], f.type)
    if (!r.ok)
      return {
        ok: false,
        message: `object.${f.name}: ${r.message}`,
      }
    out[f.name] = r.value
  }
  return { ok: true, value: out }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function typeNameOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function formatActual(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}

/**
 * Build a retry-with-feedback prompt body (text appended after the
 * original prompt) explaining which outputs failed validation and what
 * was expected. Used by the interpreter's fai-call retry loop.
 */
export function composeRetryFeedback(
  errors: ValidationErrorItem[],
  attempt: number,
  maxAttempts: number,
): string {
  const lines: string[] = []
  lines.push('[Your previous output failed validation. Please correct and try again.]')
  lines.push('')
  lines.push('Errors:')
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i]!
    lines.push(`  ${i + 1}. output \`${e.outputName}\` — ${e.message}`)
    lines.push(`     expected: ${describeType(e.expected)}`)
    if (e.actual !== undefined) {
      lines.push(`     actual:   ${JSON.stringify(e.actual)}`)
    }
  }
  lines.push('')
  lines.push(`This is attempt ${attempt + 1} of ${maxAttempts}.`)
  return lines.join('\n')
}
