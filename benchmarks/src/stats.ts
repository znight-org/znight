/** Summary of a set of samples: the median is the reported value, the quartiles and extremes its spread. */
export interface Summary {
  readonly n: number
  readonly median: number
  readonly p25: number
  readonly p75: number
  readonly min: number
  readonly max: number
}

/** Quantile `q` (0 to 1) of sorted samples, interpolated linearly between the closest ranks. */
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const a = sorted[lower] ?? Number.NaN
  const b = sorted[upper] ?? Number.NaN
  return a + (b - a) * (position - lower)
}

/** Rounds to `digits` decimals (results files stay readable and diffs small). */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function summarize(samples: readonly number[], digits = 2): Summary {
  if (samples.length === 0) throw new Error('No samples to summarize')
  const sorted = samples.toSorted((a, b) => a - b)
  return {
    n: sorted.length,
    median: round(quantile(sorted, 0.5), digits),
    p25: round(quantile(sorted, 0.25), digits),
    p75: round(quantile(sorted, 0.75), digits),
    min: round(sorted[0] ?? Number.NaN, digits),
    max: round(sorted.at(-1) ?? Number.NaN, digits),
  }
}
