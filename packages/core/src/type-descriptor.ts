/**
 * Convert AST type annotations to the adapter-spec runtime descriptor.
 *
 * The descriptor is the wire format adapters consume: it's
 * JSON-serialisable, source-location-free, and contains everything an
 * adapter needs to build a structured-output schema (JSON Schema /
 * OpenAI tool params / Anthropic tool_use / etc.).
 */

import type * as ast from './ast.js'
import type {
  TrainTypeDescriptor,
  TypeConstraintDescriptor,
} from '@tom2012/train-adapter-spec'

export function typeToDescriptor(t: ast.TypeAnnot): TrainTypeDescriptor {
  switch (t.kind) {
    case 'ScalarType':
      return {
        kind: 'scalar',
        base: t.name,
        constraint: t.constraint
          ? constraintToDescriptor(t.constraint)
          : undefined,
      }
    case 'EnumType':
      return { kind: 'enum', variants: [...t.variants] }
    case 'ArrayType':
      return {
        kind: 'array',
        element: typeToDescriptor(t.element),
        constraint: t.constraint
          ? constraintToDescriptor(t.constraint)
          : undefined,
      }
    case 'ObjectType': {
      const fields: Record<string, TrainTypeDescriptor> = {}
      for (const f of t.fields) {
        fields[f.name] = typeToDescriptor(f.type)
      }
      return { kind: 'object', fields }
    }
  }
}

function constraintToDescriptor(
  c: ast.TypeConstraint,
): TypeConstraintDescriptor {
  if (c.kind === 'RangeConstraint') {
    return { kind: 'range', min: c.min, max: c.max }
  }
  return { kind: 'named', key: c.key, value: c.value }
}

/** Recognised leaf type names (corresponds to grammar §11 Class 2). */
const LEAF_TYPES = new Set([
  'int',
  'float',
  'bool',
  'string',
  'prompt',
  'any',
])

/** Returns true if the leaf scalar type name is `prompt`. */
export function isPromptType(t: ast.TypeAnnot): boolean {
  return t.kind === 'ScalarType' && t.name === 'prompt'
}

/** Returns true if a name is a recognised leaf type at the type-position. */
export function isLeafTypeName(name: string): boolean {
  return LEAF_TYPES.has(name)
}

/** Render a TrainTypeDescriptor as a short human/LLM-readable string. */
export function describeType(t: TrainTypeDescriptor): string {
  switch (t.kind) {
    case 'scalar': {
      let s = t.base
      if (t.constraint) {
        if (t.constraint.kind === 'range') {
          s += ` ${t.constraint.min}-${t.constraint.max}`
        } else {
          const v =
            typeof t.constraint.value === 'string'
              ? `"${t.constraint.value}"`
              : String(t.constraint.value)
          s += ` ${t.constraint.key}=${v}`
        }
      }
      return s
    }
    case 'enum':
      return `enum: ${t.variants.join('|')}`
    case 'array': {
      let s = `array<${describeType(t.element)}>`
      if (t.constraint && t.constraint.kind === 'named') {
        s += ` ${t.constraint.key}=${t.constraint.value}`
      }
      return s
    }
    case 'object': {
      const fields = Object.entries(t.fields).map(
        ([k, v]) => `${k}: ${describeType(v)}`,
      )
      return `object{ ${fields.join(', ')} }`
    }
  }
}
