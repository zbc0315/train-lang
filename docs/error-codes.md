---
title: train — Error Code Registry
status: living document
updated: 2026-05-15
spec_ref: 工作流DSL测试方案.md §10.1
lint: scripts/check-error-codes.ts
---

# train Error Code Registry

This file is the **source of truth** for every `TrainErrorCode` used in
`packages/core/src/runtime.ts`. The lint script
`scripts/check-error-codes.ts` parses the TypeScript source with the TS
Compiler API and diff-compares against the codes declared below.

## Code conventions

```
E01xx — lex errors
E02xx — parse errors
E03xx — type / declaration errors
E04xx — runtime evaluation errors
E05xx — module loader errors
E06xx — fai / adapter errors
E07xx — validation errors
E08xx — i/o + state-dir + cache errors
E99xx — uncoded (legacy throws — to be migrated)
```

## Registered codes

### Module loader (E05xx)

- **E0501 CircularImport** — Import graph contains a cycle. Error message
  must include the cycle path (`a.tr → b.tr → a.tr`).
- **E0502 ModuleNotFound** — `import { x } from "./y"` where `./y.tr` does
  not exist. Message must include the resolved absolute path tried.
- **E0503 VersionMismatch** — `@v1` tag on import does not match the
  target module's declared version.
- **E0504 ImportSymbolMissing** — Named import references a symbol that
  the target module does not export. Message lists exported names.
- **E0505 ExportConflict** — Two exports of the same name in one module.

### Fai / adapter (E06xx)

- **E0601 AdapterMissing** — A `fai` was called but no `LLMAdapter` was
  passed to `runProgram`. Message includes the fai function name.
- **E0602 AdapterTimeout** — Adapter exceeded `defaultFaiTimeoutMs`.
- **E0603 AdapterError** — Adapter returned `kind: "error"` with
  `recoverable: false`.
- **E0604 RetryExhausted** — Validation kept failing after `maxAttempts`
  attempts.

### Validation (E07xx)

- **E0701 ValidationFailed** — Output failed schema validation. Body
  must include the per-field error list (compatible with
  `composeRetryFeedback`).
- **E0702 OutputShapeMismatch** — Adapter returned a different top-level
  shape than the declared `outputs` map (extra/missing keys).
- **E0703 EnumOutOfRange** — Output value is not in the declared enum
  variants. Message lists the legal values.

### I/O + state (E08xx)

- **E0801 StateDirNotWritable** — `.train/` state directory cannot be
  created or written. Message includes resolved path + reason.
- **E0802 AstCacheCorrupt** — AST cache file is corrupt JSON. The
  runtime falls back to re-parse; this code is informational only.

### Legacy

- **E9999 Uncoded** — Used by `new TrainException(...)` constructions
  that have not yet been migrated to `trainError(code, ...)`. **The
  lint script tracks the count of E9999 usages and FAILS CI if it grows
  between commits.** Existing throw sites should be migrated to specific
  codes incrementally; new code MUST use specific codes.

## How to add a new code

1. Pick the next free number in the appropriate Exx bucket (this file
   is the authority — do not pick from memory).
2. Add a `Name: 'EYYNN'` entry to `TrainErrorCode` in
   `packages/core/src/runtime.ts`.
3. Add a corresponding section to this file with: code, name, message
   contract, hint (if applicable), since-version.
4. Run `pnpm lint:error-codes` to verify.

## Lint contract

`scripts/check-error-codes.ts` is intentionally tolerant during the
migration window:

- **Declared but unused codes**: warn only (allows registration ahead
  of implementation).
- **Used but undeclared codes**: **fail** (every code in
  `TrainErrorCode` enum MUST appear in this doc).
- **E9999 usage count**: tracked. CI fails if a new commit increases
  the count vs the previous commit on `main` (preventing regression
  while permitting migration).
