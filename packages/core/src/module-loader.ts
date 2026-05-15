/**
 * Module loader (M5).
 *
 * Resolves `import { x } from "./y"` against the filesystem, parses
 * each imported file, executes its top-level once, and exposes its
 * `export`-ed names back to the importing module.
 *
 * Properties:
 *   - relative paths only in M5 (`./y`, `../y`, with implicit `.tr`)
 *   - module cache: same absolute path executes top-level exactly once
 *   - circular import detection (E0501): tracked via a re-entry set
 *   - shared adapter + builtins: child modules use the same adapter
 *     instance as the importer (no ask-user / cancellation re-plumbing)
 *
 * Not yet supported (deferred to later milestones):
 *   - namespace imports (`import * as m from "..."`)
 *   - version tags (`@v1.0.0` on import) — parsed but ignored
 *   - absolute / package imports (`@scope/name`)
 *   - workflow_data isolation per submodule (uses host stateDir)
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type * as ast from './ast.js'
import {
  TrainErrorCode,
  TrainException,
  type RuntimeContext,
  type Value,
  type FunctionValue,
  isFunctionValue,
} from './runtime.js'

export interface ModuleInstance {
  /** Absolute path of the module source file. */
  absPath: string
  /** Map of exported (external) name → runtime value. */
  exports: Map<string, Value>
  /** The RuntimeContext built during this module's top-level execution. */
  ctx: RuntimeContext
}

export interface ModuleLoaderHooks {
  /** Resolve a `from "..."` spec against an importer's abs path. */
  resolve?(spec: string, importerAbs: string): string
  /** Read source for an abs path. Default: fs.readFile utf8. */
  read?(absPath: string): Promise<string>
}

const TR_EXT = '.tr'

function defaultResolve(spec: string, importerAbs: string): string {
  if (!spec.startsWith('.') && !path.isAbsolute(spec)) {
    throw new TrainException(
      'ModuleError',
      `only relative or absolute import paths are supported in M5 (got "${spec}")`,
      undefined,
      TrainErrorCode.ModuleNotFound,
    )
  }
  const importerDir = path.dirname(importerAbs)
  let resolved = path.isAbsolute(spec) ? spec : path.resolve(importerDir, spec)
  if (!resolved.endsWith(TR_EXT)) resolved += TR_EXT
  return resolved
}

async function defaultRead(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, 'utf8')
  } catch (e) {
    throw new TrainException(
      'ModuleError',
      `module not found: ${absPath} (${(e as Error).message})`,
      undefined,
      TrainErrorCode.ModuleNotFound,
    )
  }
}

/**
 * Build a fresh ModuleRegistry for a single `train run`. The registry
 * lives for one runProgram call; subsequent runs start fresh.
 */
export interface ModuleRegistry {
  /** Load (or hit cache for) a module at the given absolute path. */
  load(absPath: string, importerStack: string[]): Promise<ModuleInstance>
  /** Resolve `spec` relative to `importerAbs` to an absolute path. */
  resolve(spec: string, importerAbs: string): string
  /** Register a module instance (used after host has executed top level). */
  set(absPath: string, instance: ModuleInstance): void
  /** Read a not-yet-cached source file. */
  read(absPath: string): Promise<string>
  /** True if path is currently being loaded (re-entry → cycle). */
  isInProgress(absPath: string): boolean
  markInProgress(absPath: string): void
  unmarkInProgress(absPath: string): void
  hasCached(absPath: string): boolean
  getCached(absPath: string): ModuleInstance | undefined
}

export function createModuleRegistry(
  hooks: ModuleLoaderHooks = {},
): ModuleRegistry {
  const cache = new Map<string, ModuleInstance>()
  const inProgress = new Set<string>()
  const resolveFn = hooks.resolve ?? defaultResolve
  const readFn = hooks.read ?? defaultRead

  return {
    resolve: resolveFn,
    read: readFn,
    set(abs, inst) {
      cache.set(abs, inst)
    },
    hasCached: (abs) => cache.has(abs),
    getCached: (abs) => cache.get(abs),
    isInProgress: (abs) => inProgress.has(abs),
    markInProgress(abs) {
      inProgress.add(abs)
    },
    unmarkInProgress(abs) {
      inProgress.delete(abs)
    },
    async load(abs, importerStack) {
      if (cache.has(abs)) return cache.get(abs)!
      if (inProgress.has(abs)) {
        const cycle = [...importerStack, abs]
          .map((p) => path.basename(p))
          .join(' → ')
        throw new TrainException(
          'ModuleError',
          `circular import: ${cycle}`,
          undefined,
          TrainErrorCode.CircularImport,
        )
      }
      // The interpreter wraps load() with executeModule(). Direct usage
      // (without that wrapper) is not supported because load() needs
      // host-controlled execution. Callers go through the interpreter.
      throw new TrainException(
        'ModuleError',
        `internal: ModuleRegistry.load called without an executor wrapper for ${abs}`,
        undefined,
        TrainErrorCode.ModuleNotFound,
      )
    },
  }
}

/**
 * Apply an Import declaration's specs to the importing module's
 * RuntimeContext, given the loaded child module instance.
 *
 * In M5 we inject imported symbols into the importer's
 * `constants` (for const exports), `globals` (for var exports), or
 * `functions` (for func / fai exports). The interpreter's identifier
 * lookup already consults these three maps in lexical order, so an
 * imported `foo` is visible just like a top-level `foo`.
 *
 * Throws ImportSymbolMissing if the import names a symbol the module
 * does not export.
 */
export function applyImport(
  imp: ast.Import,
  child: ModuleInstance,
  importerCtx: RuntimeContext,
): void {
  if (imp.clause.kind === 'NamespaceImport') {
    throw new TrainException(
      'ModuleError',
      `namespace import (\`import * as ${imp.clause.alias} from "${imp.source}"\`) is not yet supported in M5`,
      imp.range,
      TrainErrorCode.ImportSymbolMissing,
    )
  }
  for (const spec of imp.clause.specs) {
    if (!child.exports.has(spec.name)) {
      const available = [...child.exports.keys()].join(', ') || '<none>'
      throw new TrainException(
        'ModuleError',
        `module "${imp.source}" does not export "${spec.name}" (available: ${available})`,
        spec.range,
        TrainErrorCode.ImportSymbolMissing,
      )
    }
    const localName = spec.alias ?? spec.name
    // Refuse to silently shadow an existing symbol — catches both
    // `import { foo } / func foo` and duplicate `import { foo }` twice.
    // Use alias if present (`as x`), since that's the local name being
    // bound. Without this check the second `set` simply overwrote the
    // first and no warning fired.
    let conflict: string | null = null
    if (importerCtx.functions.has(localName)) conflict = 'function'
    else if (importerCtx.constants.has(localName)) conflict = 'const'
    else if (importerCtx.globals.has(localName)) conflict = 'var'
    if (conflict !== null) {
      throw new TrainException(
        'ModuleError',
        `import '${localName}' from "${imp.source}" conflicts with existing ${conflict} of the same name; use \`as\` to rename`,
        spec.range,
        TrainErrorCode.ImportSymbolMissing,
      )
    }
    const value = child.exports.get(spec.name)!
    if (isFunctionValue(value)) {
      // Re-bind imported function into importer's functions map so calls
      // resolve via the standard `ctx.functions.get(name)` path.
      importerCtx.functions.set(localName, value as FunctionValue)
    } else {
      importerCtx.constants.set(localName, value)
    }
  }
}

/** Build the export map for a module from its executed RuntimeContext. */
export function collectExports(ctx: RuntimeContext): Map<string, Value> {
  const out = new Map<string, Value>()
  for (const [externalName, internalName] of ctx.exports.entries()) {
    if (ctx.functions.has(internalName)) {
      out.set(externalName, ctx.functions.get(internalName)! as Value)
      continue
    }
    if (ctx.constants.has(internalName)) {
      out.set(externalName, ctx.constants.get(internalName)!)
      continue
    }
    if (ctx.globals.has(internalName)) {
      out.set(externalName, ctx.globals.get(internalName)!)
      continue
    }
    // Export declared but no value bound — silently skip; caller errors when
    // a downstream module tries to import this name.
  }
  return out
}
