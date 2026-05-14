/**
 * Corpus test — runs the parser over all .tr fixture files in:
 *
 *   test/fixtures/valid/    → must parse with zero errors
 *   test/fixtures/invalid/  → must produce at least one parse error
 *
 * To add a new case: drop a .tr file into the appropriate directory.
 * No code change required; the test discovery is filesystem-driven.
 *
 * Naming convention: numeric prefix + dash-case description.
 *   e.g. `21-new-feature.tr`
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../src/index.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadFixtures(category: 'valid' | 'invalid'): Array<{
  name: string
  source: string
}> {
  const dir = join(FIXTURES_DIR, category)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tr'))
    .sort()
    .map((f) => ({
      name: f,
      source: readFileSync(join(dir, f), 'utf8'),
    }))
}

describe('corpus: valid fixtures parse cleanly', () => {
  const cases = loadFixtures('valid')

  it('has expected number of fixtures', () => {
    // Guard so accidental fixture deletions surface as a clear failure
    expect(cases.length).toBeGreaterThanOrEqual(20)
  })

  for (const { name, source } of cases) {
    it(name, () => {
      const result = parse(source)
      expect(
        result.lexErrors,
        `lex errors in valid/${name}`,
      ).toEqual([])
      expect(
        result.parseErrors,
        `parse errors in valid/${name}`,
      ).toEqual([])
    })
  }
})

describe('corpus: invalid fixtures produce errors', () => {
  const cases = loadFixtures('invalid')

  it('has expected number of fixtures', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5)
  })

  for (const { name, source } of cases) {
    it(name, () => {
      const result = parse(source)
      const hasError =
        result.lexErrors.length > 0 || result.parseErrors.length > 0
      expect(
        hasError,
        `expected invalid/${name} to fail lex or parse, but it succeeded`,
      ).toBe(true)
    })
  }
})
