/**
 * Byte sizes (`1048576`, `'512kb'`, `'10 MiB'`, `'1.5gb'`) used by body and upload limits. This
 * module is **pure** (no imports, no I/O): the compiler extension evaluates `@BodyLimit('10mb')` and
 * `maxSize` options with it at build time.
 *
 * Units are case-insensitive and binary, like the `bytes` package used by Express:
 * `b`, `kb`/`kib`/`k` = 1024, `mb`/`mib`/`m` = 1024², `gb`/`gib`/`g` = 1024³, `tb`/`tib`/`t` = 1024⁴.
 */

/**
 * A size in bytes: a non-negative integer (`Infinity` disables the limit) or a string with a unit
 * (`'512kb'`, `'10mb'`, `'1.5 GiB'`; `kb` = 1024 bytes).
 */
export type ByteSize = number | string

const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
}

const SIZE = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/i

/**
 * Parses a {@link ByteSize}: `1024` → `1024`, `'10mb'` → `10485760`, `'1.5kb'` → `1536` (fractions
 * are rounded down). Returns `undefined` for anything else (negative or fractional numbers,
 * unknown units, `NaN`).
 */
export function parseByteSize(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (value === Number.POSITIVE_INFINITY) return value
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  if (typeof value !== 'string') return undefined
  const match = SIZE.exec(value.trim())
  if (match === null) return undefined
  const unit = (match[2] as string).toLowerCase()
  const multiplier = unit === '' ? 1 : UNITS[unit]
  if (multiplier === undefined) return undefined
  const bytes = Math.floor(Number(match[1]) * multiplier)
  return Number.isSafeInteger(bytes) ? bytes : undefined
}

/** Human-readable size for messages: `5 MiB`, `1.5 KiB`, `512 bytes`, `unlimited`. */
export function formatByteSize(bytes: number): string {
  if (bytes === Number.POSITIVE_INFINITY) return 'unlimited'
  for (const [unit, size] of [
    ['TiB', 1024 ** 4],
    ['GiB', 1024 ** 3],
    ['MiB', 1024 ** 2],
    ['KiB', 1024],
  ] as const) {
    if (bytes >= size) return `${Number((bytes / size).toFixed(2))} ${unit}`
  }
  return bytes === 1 ? '1 byte' : `${bytes} bytes`
}
