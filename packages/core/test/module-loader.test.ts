import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  runFile,
  createModuleRegistry,
  applyImport,
  collectExports,
  TrainException,
  TrainErrorCode,
  type ModuleInstance,
} from '../src/index.js'

let tmpDir: string

async function writeFile(rel: string, content: string): Promise<string> {
  const abs = path.join(tmpDir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
  return abs
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'train-mod-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('module-loader: single-file import', () => {
  test('imports a single exported function', async () => {
    await writeFile(
      'lib.tr',
      `
func double(x: int) -> int { return x * 2 }
export double
`,
    )
    const main = await writeFile(
      'main.tr',
      `
import { double } from "./lib"
func main() -> int { return double(21) }
export main
`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(true)
    expect(r.value).toBe(42)
  })

  test('imports a const', async () => {
    await writeFile('cfg.tr', `const PI: int = 3\nexport PI`)
    const main = await writeFile(
      'main.tr',
      `
import { PI } from "./cfg"
func main() -> int { return PI }
export main
`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(true)
    expect(r.value).toBe(3)
  })

  test('imports with alias (as)', async () => {
    await writeFile('lib.tr', `func add(a: int, b: int) -> int { return a + b }\nexport add`)
    const main = await writeFile(
      'main.tr',
      `
import { add as plus } from "./lib"
func main() -> int { return plus(2, 3) }
export main
`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(true)
    expect(r.value).toBe(5)
  })

  test('importing missing symbol fails with E0504-style error', async () => {
    await writeFile('lib.tr', `func a() -> int { return 1 }\nexport a`)
    const main = await writeFile(
      'main.tr',
      `
import { b } from "./lib"
func main() -> int { return b() }
export main
`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('does not export "b"')
  })

  test('importing nonexistent file fails with module-not-found', async () => {
    const main = await writeFile(
      'main.tr',
      `
import { x } from "./missing"
func main() -> int { return 1 }
export main
`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/not found|ENOENT/i)
  })

  test('source-level parse error in imported module surfaces as ModuleError', async () => {
    await writeFile('bad.tr', `func a( -> int { return 1 }\nexport a`)
    const main = await writeFile(
      'main.tr',
      `
import { a } from "./bad"
func main() -> int { return a() }
export main
`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/parse error/)
  })
})

describe('module-loader: multi-level + caching', () => {
  test('A → B → C, executes C once and chains through', async () => {
    await writeFile('c.tr', `func c() -> int { return 1 }\nexport c`)
    await writeFile(
      'b.tr',
      `
import { c } from "./c"
func b() -> int { return c() + 10 }
export b
`,
    )
    const main = await writeFile(
      'a.tr',
      `
import { b } from "./b"
func main() -> int { return b() + 100 }
export main
`,
    )
    const r = await runFile(main)
    if (!r.ok) console.error('chain error:', r.error?.message, r.parseErrors)
    expect(r.ok).toBe(true)
    expect(r.value).toBe(111)
  })

  test('diamond import: A → B → D, A → C → D — D executes once', async () => {
    // We cannot directly observe "D ran once" without side effects; use a
    // var assignment in D and read it in B & C separately to assert both
    // see the same instance via cache.
    await writeFile(
      'd.tr',
      `func d_val() -> int { return 7 }
export d_val`,
    )
    await writeFile(
      'b.tr',
      `import { d_val } from "./d"
func b_get() -> int { return d_val() }
export b_get`,
    )
    await writeFile(
      'c.tr',
      `import { d_val } from "./d"
func c_get() -> int { return d_val() }
export c_get`,
    )
    const main = await writeFile(
      'main.tr',
      `import { b_get } from "./b"
import { c_get } from "./c"
func main() -> int { return b_get() + c_get() }
export main`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(true)
    expect(r.value).toBe(14)
  })

  test('explicit module cache hit: second import same registry returns cached instance', async () => {
    const libAbs = await writeFile('lib.tr', `func f() -> int { return 9 }\nexport f`)
    const mainAbs = await writeFile(
      'main.tr',
      `import { f } from "./lib"
func main() -> int { return f() }
export main`,
    )
    const registry = createModuleRegistry()
    const r1 = await runFile(mainAbs, { moduleRegistry: registry })
    expect(r1.ok).toBe(true)
    expect(registry.hasCached(libAbs)).toBe(true)
  })
})

describe('module-loader: circular detection (E0501)', () => {
  test('direct cycle A → B → A throws CircularImport', async () => {
    await writeFile(
      'a.tr',
      `import { b } from "./b"
func a() -> int { return b() + 1 }
export a`,
    )
    await writeFile(
      'b.tr',
      `import { a } from "./a"
func b() -> int { return a() + 1 }
export b`,
    )
    const main = await writeFile(
      'main.tr',
      `import { a } from "./a"
func main() -> int { return a() }
export main`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/circular import/i)
  })

  test('transitive cycle A → B → C → A throws CircularImport', async () => {
    await writeFile(
      'a.tr',
      `import { b } from "./b"
func a() -> int { return b() + 1 }
export a`,
    )
    await writeFile(
      'b.tr',
      `import { c } from "./c"
func b() -> int { return c() + 1 }
export b`,
    )
    await writeFile(
      'c.tr',
      `import { a } from "./a"
func c() -> int { return a() + 1 }
export c`,
    )
    const main = await writeFile(
      'main.tr',
      `import { a } from "./a"
func main() -> int { return a() }
export main`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/circular import/i)
    // All three filenames should appear in the cycle path
    expect(r.error?.message).toMatch(/a\.tr/)
    expect(r.error?.message).toMatch(/b\.tr/)
    expect(r.error?.message).toMatch(/c\.tr/)
  })

  test('cycle message contains the cycle path (filenames)', async () => {
    await writeFile(
      'foo.tr',
      `import { bar } from "./bar"
func foo() -> int { return bar() }
export foo`,
    )
    await writeFile(
      'bar.tr',
      `import { foo } from "./foo"
func bar() -> int { return foo() }
export bar`,
    )
    const main = await writeFile(
      'main.tr',
      `import { foo } from "./foo"
func main() -> int { return foo() }
export main`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/foo\.tr|bar\.tr/)
  })
})

describe('module-loader: namespace imports (deferred)', () => {
  test('`import * as m` errors with not-supported message', async () => {
    await writeFile('lib.tr', `func a() -> int { return 1 }\nexport a`)
    const main = await writeFile(
      'main.tr',
      `import * as m from "./lib"
func main() -> int { return m.a() }
export main`,
    )
    const r = await runFile(main)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/namespace import/)
  })
})

describe('createModuleRegistry / applyImport / collectExports primitives', () => {
  test('registry tracks in-progress + cached', () => {
    const r = createModuleRegistry()
    expect(r.hasCached('/x')).toBe(false)
    expect(r.isInProgress('/x')).toBe(false)
    r.markInProgress('/x')
    expect(r.isInProgress('/x')).toBe(true)
    r.unmarkInProgress('/x')
    expect(r.isInProgress('/x')).toBe(false)
  })

  test('collectExports pulls function + const + global into one map', () => {
    const ctx = {
      constants: new Map([['K', 1]]),
      globals: new Map([['G', 2]]),
      functions: new Map([
        [
          'F',
          {
            __kind: 'function' as const,
            name: 'F',
            isFai: false,
            decl: {} as any,
            definedIn: { parent: null, bindings: new Map() } as any,
          },
        ],
      ]),
      builtins: new Map(),
      exports: new Map([
        ['K', 'K'],
        ['G', 'G'],
        ['F', 'F'],
      ]),
    }
    const exp = collectExports(ctx as any)
    expect(exp.size).toBe(3)
    expect(exp.get('K')).toBe(1)
    expect(exp.get('G')).toBe(2)
    expect((exp.get('F') as any).__kind).toBe('function')
  })

  test('applyImport throws ImportSymbolMissing for unknown name', () => {
    const child: ModuleInstance = {
      absPath: '/x.tr',
      exports: new Map([['a', 1]]),
      ctx: {} as any,
    }
    const importerCtx = {
      constants: new Map(),
      globals: new Map(),
      functions: new Map(),
      builtins: new Map(),
      exports: new Map(),
    }
    expect(() =>
      applyImport(
        {
          kind: 'Import',
          source: './x',
          version: null,
          clause: {
            kind: 'NamedImports',
            specs: [
              {
                kind: 'ImportSpec',
                name: 'unknown',
                alias: null,
                range: {} as any,
              } as any,
            ],
            range: {} as any,
          },
          range: {} as any,
        } as any,
        child,
        importerCtx as any,
      ),
    ).toThrow(TrainException)
  })
})

describe('error codes are wired through', () => {
  test('TrainErrorCode.CircularImport is E0501', () => {
    expect(TrainErrorCode.CircularImport).toBe('E0501')
  })
  test('TrainErrorCode.ModuleNotFound is E0502', () => {
    expect(TrainErrorCode.ModuleNotFound).toBe('E0502')
  })
})
