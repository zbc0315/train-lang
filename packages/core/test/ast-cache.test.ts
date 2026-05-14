import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AST_CACHE_VERSION,
  sourceHash,
  cacheFilePath,
  saveCache,
  loadCache,
  normalizeForCache,
  parseWithCache,
} from '../src/ast-cache.js'
import { parseToAst } from '../src/index.js'

const HELLO_SRC = `
func main() -> int {
  let r = 1 + 2
  return r
}
export main
`

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'train-cache-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('sourceHash', () => {
  test('same source → same hash', () => {
    expect(sourceHash('abc')).toBe(sourceHash('abc'))
  })

  test('different source → different hash', () => {
    expect(sourceHash('abc')).not.toBe(sourceHash('abd'))
  })

  test('hash is sha256 prefixed', () => {
    expect(sourceHash('x')).toMatch(/^sha256-[0-9a-f]{64}$/)
  })
})

describe('cacheFilePath', () => {
  test('joins under stateDir/ast/', () => {
    const p = cacheFilePath('/state', 'a/b.tr')
    expect(p).toBe(path.join('/state', 'ast', 'a/b.tr.ast.json'))
  })
})

describe('saveCache + loadCache', () => {
  test('round-trip a parsed AST', async () => {
    const { ast } = parseToAst(HELLO_SRC)
    expect(ast).not.toBeNull()
    const hash = sourceHash(HELLO_SRC)
    const p = cacheFilePath(tmpDir, 'hello.tr')
    await saveCache(p, {
      sourceFile: 'hello.tr',
      sourceHash: hash,
      compilerVersion: AST_CACHE_VERSION,
      compiledAt: new Date().toISOString(),
      ast: ast!,
    })
    const loaded = await loadCache(p, hash)
    expect(loaded).not.toBeNull()
    expect(loaded!.ast.kind).toBe('Program')
    expect(normalizeForCache(loaded!.ast)).toEqual(normalizeForCache(ast!))
  })

  test('cache miss when sourceHash differs', async () => {
    const { ast } = parseToAst(HELLO_SRC)
    const p = cacheFilePath(tmpDir, 'a.tr')
    await saveCache(p, {
      sourceFile: 'a.tr',
      sourceHash: sourceHash('original'),
      compilerVersion: AST_CACHE_VERSION,
      compiledAt: new Date().toISOString(),
      ast: ast!,
    })
    const loaded = await loadCache(p, sourceHash('different'))
    expect(loaded).toBeNull()
  })

  test('cache miss when compilerVersion differs', async () => {
    const { ast } = parseToAst(HELLO_SRC)
    const hash = sourceHash(HELLO_SRC)
    const p = cacheFilePath(tmpDir, 'a.tr')
    await saveCache(p, {
      sourceFile: 'a.tr',
      sourceHash: hash,
      compilerVersion: 'train-core-OLD',
      compiledAt: new Date().toISOString(),
      ast: ast!,
    })
    const loaded = await loadCache(p, hash)
    expect(loaded).toBeNull()
  })

  test('cache miss when file does not exist', async () => {
    const loaded = await loadCache(
      path.join(tmpDir, 'nonexistent.json'),
      'h',
    )
    expect(loaded).toBeNull()
  })

  test('corrupt JSON returns null, does not throw', async () => {
    const p = cacheFilePath(tmpDir, 'corrupt.tr')
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, '{not valid', 'utf8')
    const loaded = await loadCache(p, 'h')
    expect(loaded).toBeNull()
  })

  test('missing required fields returns null', async () => {
    const p = cacheFilePath(tmpDir, 'partial.tr')
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(
      p,
      JSON.stringify({ sourceFile: 'x', sourceHash: 'h' }),
      'utf8',
    )
    const loaded = await loadCache(p, 'h')
    expect(loaded).toBeNull()
  })

  test('saveCache atomic via rename — no partial file on success', async () => {
    const { ast } = parseToAst(HELLO_SRC)
    const p = cacheFilePath(tmpDir, 'atomic.tr')
    await saveCache(p, {
      sourceFile: 'atomic.tr',
      sourceHash: 'h',
      compilerVersion: AST_CACHE_VERSION,
      compiledAt: 'now',
      ast: ast!,
    })
    const dir = path.dirname(p)
    const entries = await fs.readdir(dir)
    const tmpFiles = entries.filter((e) => e.includes('.tmp-'))
    expect(tmpFiles).toEqual([])
  })
})

describe('normalizeForCache', () => {
  test('strips range field anywhere in tree', () => {
    const ast = {
      kind: 'Program',
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5, startOffset: 0, endOffset: 4 },
      items: [
        { kind: 'X', range: { startLine: 2 }, name: 'a' },
      ],
    }
    const norm = normalizeForCache(ast) as any
    expect(norm.range).toBeUndefined()
    expect(norm.items[0].range).toBeUndefined()
    expect(norm.items[0].name).toBe('a')
  })

  test('preserves array order', () => {
    const result = normalizeForCache([3, 1, 2]) as number[]
    expect(result).toEqual([3, 1, 2])
  })

  test('NaN stringified', () => {
    expect(normalizeForCache(NaN)).toBe('NaN')
  })

  test('Infinity stringified', () => {
    expect(normalizeForCache(Infinity)).toBe('Infinity')
    expect(normalizeForCache(-Infinity)).toBe('-Infinity')
  })

  test('null preserved', () => {
    expect(normalizeForCache(null)).toBeNull()
  })

  test('two parse runs of same source produce normalized-equal ASTs (INV-14)', () => {
    const a = parseToAst(HELLO_SRC).ast
    const b = parseToAst(HELLO_SRC).ast
    expect(normalizeForCache(a)).toEqual(normalizeForCache(b))
  })
})

describe('parseWithCache facade', () => {
  test('first call: parses fresh + writes cache', async () => {
    const r = await parseWithCache({
      source: HELLO_SRC,
      sourceFile: 'h.tr',
      stateDir: tmpDir,
      parseFresh: parseToAst,
    })
    expect(r.fromCache).toBe(false)
    expect(r.ast).not.toBeNull()
    expect(r.parseErrors).toEqual([])
    const p = cacheFilePath(tmpDir, 'h.tr')
    const exists = await fs.stat(p).then(
      () => true,
      () => false,
    )
    expect(exists).toBe(true)
  })

  test('second call with same source: cache hit', async () => {
    await parseWithCache({
      source: HELLO_SRC,
      sourceFile: 'h.tr',
      stateDir: tmpDir,
      parseFresh: parseToAst,
    })
    const r2 = await parseWithCache({
      source: HELLO_SRC,
      sourceFile: 'h.tr',
      stateDir: tmpDir,
      parseFresh: parseToAst,
    })
    expect(r2.fromCache).toBe(true)
    expect(r2.ast).not.toBeNull()
  })

  test('source changed → cache miss → re-parse', async () => {
    await parseWithCache({
      source: HELLO_SRC,
      sourceFile: 'h.tr',
      stateDir: tmpDir,
      parseFresh: parseToAst,
    })
    const r2 = await parseWithCache({
      source: HELLO_SRC + '\n// changed',
      sourceFile: 'h.tr',
      stateDir: tmpDir,
      parseFresh: parseToAst,
    })
    expect(r2.fromCache).toBe(false)
  })

  test('source with parse errors not cached', async () => {
    const bad = 'func main() { let = ; }'
    const r = await parseWithCache({
      source: bad,
      sourceFile: 'bad.tr',
      stateDir: tmpDir,
      parseFresh: parseToAst,
    })
    expect(r.fromCache).toBe(false)
    expect(r.parseErrors.length).toBeGreaterThan(0)
    const p = cacheFilePath(tmpDir, 'bad.tr')
    const exists = await fs.stat(p).then(
      () => true,
      () => false,
    )
    expect(exists).toBe(false)
  })
})
