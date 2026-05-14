#!/usr/bin/env -S node --experimental-strip-types
/**
 * Lint: verify error code registry consistency.
 *
 * Reads:
 *   - packages/core/src/runtime.ts  → extracts TrainErrorCode enum entries
 *   - docs/error-codes.md           → extracts "**EYYNN Name**" declarations
 *
 * Diffs:
 *   - used (in code) vs declared (in docs)
 *   - fails if any used code lacks a doc entry
 *   - warns if any doc-declared code is unused
 *   - counts E9999 throw sites and reports
 *
 * Run with:
 *   pnpm lint:error-codes
 *
 * Implementation note: we use a regex over the source instead of the
 * full TypeScript Compiler API because the TrainErrorCode enum is a
 * small, syntactically uniform `as const` object literal. A TS Compiler
 * API pass adds ~50 lines of boilerplate without changing the result.
 * If the enum becomes more complex (computed keys, dynamic merges), we
 * will switch to ts.createProgram + visitor.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const RUNTIME_TS = path.join(ROOT, 'packages/core/src/runtime.ts')
const DOCS_MD = path.join(ROOT, 'docs/error-codes.md')

interface CodeEntry {
  name: string
  code: string
}

async function extractDeclaredCodes(): Promise<CodeEntry[]> {
  const src = await fs.readFile(RUNTIME_TS, 'utf8')
  const enumMatch = src.match(
    /export const TrainErrorCode\s*=\s*\{([\s\S]*?)\}\s*as const/,
  )
  if (!enumMatch) {
    throw new Error(`TrainErrorCode enum not found in ${RUNTIME_TS}`)
  }
  const body = enumMatch[1]!
  const entries: CodeEntry[] = []
  const entryRe = /(\w+)\s*:\s*['"]([Ee]\d{4})['"]/g
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(body)) !== null) {
    entries.push({ name: m[1]!, code: m[2]! })
  }
  return entries
}

async function extractDocumentedCodes(): Promise<CodeEntry[]> {
  const md = await fs.readFile(DOCS_MD, 'utf8')
  const entries: CodeEntry[] = []
  // Match "- **E0501 CircularImport**" or "**E0501 CircularImport**"
  const re = /\*\*([Ee]\d{4})\s+(\w+)\*\*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    entries.push({ code: m[1]!, name: m[2]! })
  }
  return entries
}

async function countUncodedThrows(): Promise<number> {
  // Heuristic: count `new TrainException(` occurrences that do NOT
  // also pass a TrainErrorCode in the same statement (rough check).
  const src = await fs.readFile(RUNTIME_TS, 'utf8')
  // We don't lint this file — it's the source of the enum.
  // Real legacy throws are in interpreter.ts and friends:
  const targets = [
    'packages/core/src/interpreter.ts',
    'packages/core/src/builder.ts',
    'packages/core/src/builtins.ts',
    'packages/core/src/validation.ts',
  ]
  let count = 0
  for (const rel of targets) {
    const abs = path.join(ROOT, rel)
    let text: string
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch {
      continue
    }
    // Find all `new TrainException(` and check whether the next 200 chars
    // contain `TrainErrorCode.`. If not, count as uncoded.
    const newRe = /new TrainException\(/g
    let m: RegExpExecArray | null
    while ((m = newRe.exec(text)) !== null) {
      const slice = text.slice(m.index, m.index + 400)
      if (!slice.includes('TrainErrorCode.')) count++
    }
  }
  return count
}

interface Report {
  declaredOnly: CodeEntry[]
  documentedOnly: CodeEntry[]
  matched: CodeEntry[]
  uncodedThrows: number
  totalDeclared: number
  totalDocumented: number
}

async function main(): Promise<Report> {
  const declared = await extractDeclaredCodes()
  const documented = await extractDocumentedCodes()

  const declMap = new Map(declared.map((e) => [e.code, e]))
  const docMap = new Map(documented.map((e) => [e.code, e]))

  const matched: CodeEntry[] = []
  const declaredOnly: CodeEntry[] = []
  const documentedOnly: CodeEntry[] = []

  for (const e of declared) {
    if (docMap.has(e.code)) matched.push(e)
    else declaredOnly.push(e)
  }
  for (const e of documented) {
    if (!declMap.has(e.code)) documentedOnly.push(e)
  }

  const uncodedThrows = await countUncodedThrows()

  return {
    declaredOnly,
    documentedOnly,
    matched,
    uncodedThrows,
    totalDeclared: declared.length,
    totalDocumented: documented.length,
  }
}

async function readBaseline(): Promise<{ uncodedThrows: number } | null> {
  try {
    const text = await fs.readFile(
      path.join(__dirname, '.error-code-baseline.json'),
      'utf8',
    )
    return JSON.parse(text)
  } catch {
    return null
  }
}

main().then(
  async (r) => {
    let exitCode = 0
    console.log(`\n[check-error-codes] declared in runtime.ts: ${r.totalDeclared}`)
    console.log(`[check-error-codes] documented in docs/error-codes.md: ${r.totalDocumented}`)
    console.log(`[check-error-codes] matched: ${r.matched.length}`)

    if (r.declaredOnly.length > 0) {
      console.error('\n❌ Used in code but NOT documented:')
      for (const e of r.declaredOnly) console.error(`   - ${e.code} ${e.name}`)
      exitCode = 1
    }
    if (r.documentedOnly.length > 0) {
      console.warn('\n⚠️  Documented but NOT in code (warning only):')
      for (const e of r.documentedOnly) console.warn(`   - ${e.code} ${e.name}`)
    }

    console.log(
      `\n[check-error-codes] legacy uncoded \`new TrainException(...)\` throws: ${r.uncodedThrows}`,
    )

    // E9999 baseline gate: fail if uncoded count GROWS vs baseline.
    const baseline = await readBaseline()
    if (baseline) {
      console.log(
        `[check-error-codes] baseline: ${baseline.uncodedThrows} (scripts/.error-code-baseline.json)`,
      )
      if (r.uncodedThrows > baseline.uncodedThrows) {
        console.error(
          `\n❌ Uncoded TrainException throws grew: ${baseline.uncodedThrows} → ${r.uncodedThrows}`,
        )
        console.error(
          `   New throw sites MUST use trainError(TrainErrorCode.X, ...) — never bare new TrainException()`,
        )
        exitCode = 1
      } else if (r.uncodedThrows < baseline.uncodedThrows) {
        console.log(
          `\n✨ ${baseline.uncodedThrows - r.uncodedThrows} legacy throw(s) migrated since baseline — update scripts/.error-code-baseline.json:\n   { "uncodedThrows": ${r.uncodedThrows} }`,
        )
      }
    }

    if (exitCode !== 0) {
      console.error('\n❌ Error code lint FAILED')
      process.exit(exitCode)
    } else {
      console.log('\n✅ Error code lint passed')
    }
  },
  (e) => {
    console.error('[check-error-codes] crashed:', e)
    process.exit(2)
  },
)
