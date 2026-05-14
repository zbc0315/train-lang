/**
 * AST cache (spec §4.5).
 *
 * Persist parsed AST to `<stateDir>/ast/<relativeFile>.ast.json` keyed by
 * sha256(source) + compilerVersion. On reload, verify both — if either
 * mismatches, return null and the caller re-parses.
 *
 * The cache file is plain JSON (no functions, no circular refs). All
 * train AST nodes are plain objects with primitive leaves + Range info,
 * so JSON.stringify is lossless.
 *
 * `normalizeForCache` strips fields that vary between runs (range,
 * future __id, etc.) so two ASTs of the same source can be compared
 * for equivalence by deep-equal of their normalized forms.
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type * as ast from './ast.js'

/** Bump whenever AST shape changes — invalidates all caches. */
export const AST_CACHE_VERSION = 'train-core-0.1.0'

export interface AstCacheRecord {
  sourceFile: string
  sourceHash: string
  compilerVersion: string
  compiledAt: string
  ast: ast.Program
}

/** Compute the cache key for a source string. */
export function sourceHash(source: string): string {
  return 'sha256-' + createHash('sha256').update(source, 'utf8').digest('hex')
}

/** Resolve cache file path under stateDir. */
export function cacheFilePath(stateDir: string, relSourceFile: string): string {
  return path.join(stateDir, 'ast', relSourceFile + '.ast.json')
}

/**
 * Save AST to cache file. Atomic: write to tmp then rename.
 * Creates parent dirs as needed. Throws on filesystem errors.
 */
export async function saveCache(
  cachePath: string,
  record: AstCacheRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  const tmp = cachePath + '.tmp-' + process.pid
  const json = JSON.stringify(record)
  await fs.writeFile(tmp, json, 'utf8')
  await fs.rename(tmp, cachePath)
}

/**
 * Load AST from cache file. Returns null if:
 *  - file does not exist
 *  - file is corrupt / not valid JSON / missing fields
 *  - sourceHash does not match the caller's expected hash
 *  - compilerVersion does not match AST_CACHE_VERSION
 *
 * Never throws on cache miss — caller should re-parse on null.
 */
export async function loadCache(
  cachePath: string,
  expectedHash: string,
  expectedCompilerVersion: string = AST_CACHE_VERSION,
): Promise<AstCacheRecord | null> {
  let raw: string
  try {
    raw = await fs.readFile(cachePath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Partial<AstCacheRecord>
  if (
    typeof record.sourceHash !== 'string' ||
    typeof record.compilerVersion !== 'string' ||
    typeof record.compiledAt !== 'string' ||
    typeof record.sourceFile !== 'string' ||
    !record.ast ||
    typeof record.ast !== 'object'
  ) {
    return null
  }
  if (record.sourceHash !== expectedHash) return null
  if (record.compilerVersion !== expectedCompilerVersion) return null
  return record as AstCacheRecord
}

/**
 * Normalize an AST for equivalence comparison. Strips fields that vary
 * between parse runs but do not carry semantic meaning. See
 * 工作流DSL测试方案.md §7.1 INV-14 for the formal contract.
 *
 * Currently strips:
 *   - `range` (chevrotain source offsets)
 *   - future `__id` (DFS node identifiers — not yet present)
 *
 * Preserves:
 *   - all semantic fields (type, name, value, params, body, children)
 *   - array order
 *
 * Numeric edge cases:
 *   - NaN / Infinity → string "NaN" / "Infinity" (JSON unfriendly otherwise)
 */
const STRIP_KEYS = new Set(['range', '__id'])

export function normalizeForCache(node: unknown): unknown {
  if (node === null || typeof node !== 'object') {
    if (typeof node === 'number') {
      if (Number.isNaN(node)) return 'NaN'
      if (!Number.isFinite(node)) return node > 0 ? 'Infinity' : '-Infinity'
    }
    return node
  }
  if (Array.isArray(node)) {
    return node.map(normalizeForCache)
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (STRIP_KEYS.has(k)) continue
    out[k] = normalizeForCache(v)
  }
  return out
}

/**
 * High-level facade: parse with cache.
 *
 * If a valid cached AST exists, return it. Otherwise call `parseFresh`,
 * save the result to cache, and return it.
 *
 * `parseFresh` returns the AST plus any errors. Cache only on no-error.
 */
export interface ParseWithCacheResult {
  ast: ast.Program | null
  source: string
  fromCache: boolean
  /** Hash of source used for cache lookup. */
  hash: string
  /** Any error from parseFresh, if cache was missed. */
  lexErrors: ReadonlyArray<unknown>
  parseErrors: ReadonlyArray<unknown>
}

export async function parseWithCache(opts: {
  source: string
  sourceFile: string
  stateDir: string
  parseFresh: (src: string) => {
    ast: ast.Program | null
    lexErrors: ReadonlyArray<unknown>
    parseErrors: ReadonlyArray<unknown>
  }
}): Promise<ParseWithCacheResult> {
  const hash = sourceHash(opts.source)
  const cachePath = cacheFilePath(opts.stateDir, opts.sourceFile)
  const cached = await loadCache(cachePath, hash)
  if (cached) {
    return {
      ast: cached.ast,
      source: opts.source,
      fromCache: true,
      hash,
      lexErrors: [],
      parseErrors: [],
    }
  }
  const fresh = opts.parseFresh(opts.source)
  if (fresh.ast && fresh.lexErrors.length === 0 && fresh.parseErrors.length === 0) {
    try {
      await saveCache(cachePath, {
        sourceFile: opts.sourceFile,
        sourceHash: hash,
        compilerVersion: AST_CACHE_VERSION,
        compiledAt: new Date().toISOString(),
        ast: fresh.ast,
      })
    } catch {
      // Cache save failure is non-fatal — the AST is still usable in memory.
    }
  }
  return {
    ast: fresh.ast,
    source: opts.source,
    fromCache: false,
    hash,
    lexErrors: fresh.lexErrors,
    parseErrors: fresh.parseErrors,
  }
}
