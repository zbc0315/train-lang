import type { TrainException } from '@train-lang/core'

export interface FormattedError {
  exitCode: 1 | 2
  text: string
}

interface ChevrotainLexError {
  offset: number
  line?: number
  column?: number
  length?: number
  message: string
}

interface ChevrotainParseError {
  message: string
  name: string
  token?: {
    startOffset?: number
    startLine?: number
    startColumn?: number
    image?: string
  }
}

const MAX_SOURCE_PREVIEW = 120

function caretLine(column: number, length: number): string {
  const pad = ' '.repeat(Math.max(0, column - 1))
  const carets = '^'.repeat(Math.max(1, length))
  return pad + carets
}

function getSourceLine(source: string, line: number): string {
  const lines = source.split(/\r?\n/)
  return lines[line - 1] ?? ''
}

function truncate(s: string): string {
  if (s.length <= MAX_SOURCE_PREVIEW) return s
  return s.slice(0, MAX_SOURCE_PREVIEW - 3) + '...'
}

function frame(
  filename: string,
  line: number,
  column: number,
  source: string,
  length = 1,
): string {
  const fullLine = getSourceLine(source, line)
  const sourceLine = truncate(fullLine)
  const truncated = sourceLine.length < fullLine.length
  // Clamp caret to within the displayed slice; preserve original col in header.
  const displayedColumn =
    truncated && column > sourceLine.length
      ? sourceLine.length
      : column
  const clampedLength = Math.max(
    1,
    Math.min(length, Math.max(1, sourceLine.length - displayedColumn + 1)),
  )
  const lineNumStr = String(line)
  const gutter = ' '.repeat(lineNumStr.length)
  const headerLoc = `${filename}:${line}:${column}${truncated ? ' (line truncated)' : ''}`
  return [
    `  --> ${headerLoc}`,
    `  ${gutter} |`,
    `  ${lineNumStr} | ${sourceLine}`,
    `  ${gutter} | ${caretLine(displayedColumn, clampedLength)}`,
  ].join('\n')
}

export function formatLexErrors(
  errors: ReadonlyArray<unknown>,
  filename: string,
  source: string,
): FormattedError {
  const parts: string[] = []
  for (const raw of errors) {
    const err = raw as ChevrotainLexError
    const line = err.line ?? 1
    const column = err.column ?? 1
    const length = err.length ?? 1
    parts.push(
      `error[LexError]: ${err.message}\n${frame(filename, line, column, source, length)}`,
    )
  }
  return { exitCode: 1, text: parts.join('\n\n') }
}

export function formatParseErrors(
  errors: ReadonlyArray<unknown>,
  filename: string,
  source: string,
): FormattedError {
  const parts: string[] = []
  for (const raw of errors) {
    const err = raw as ChevrotainParseError
    const line = err.token?.startLine ?? 1
    const column = err.token?.startColumn ?? 1
    const length = err.token?.image?.length ?? 1
    parts.push(
      `error[${err.name || 'ParseError'}]: ${err.message}\n${frame(filename, line, column, source, length)}`,
    )
  }
  return { exitCode: 1, text: parts.join('\n\n') }
}

export function formatRuntimeError(
  exc: TrainException,
  filename: string,
  source: string,
): FormattedError {
  if (exc.range) {
    const { startLine, startColumn, endLine, endColumn } = exc.range
    // chevrotain ranges use inclusive end columns; +1 to count both endpoints.
    const length =
      startLine === endLine
        ? Math.max(1, endColumn - startColumn + 1)
        : 1
    return {
      exitCode: 2,
      text: `error[${exc.errorType}]: ${exc.message}\n${frame(
        filename,
        startLine,
        startColumn,
        source,
        length,
      )}`,
    }
  }
  return {
    exitCode: 2,
    text: `error[${exc.errorType}]: ${exc.message}\n  --> ${filename}`,
  }
}
