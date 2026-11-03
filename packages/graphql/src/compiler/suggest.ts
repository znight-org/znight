/**
 * "Did you mean" suggestions of the schema-first diagnostics (RFC 0007 §5.3). Import-free.
 */

/**
 * The candidate closest to `name` (Levenshtein distance, case differences counting half), when it
 * is close enough to be a typo: at most a third of the name's length, at least 1. Ties keep the
 * first candidate, so callers pass them sorted.
 */
export function closest(name: string, candidates: readonly string[]): string | undefined {
  const limit = Math.max(1, Math.floor(name.length / 3))
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (candidate === name) continue
    const distance = candidate.toLowerCase() === name.toLowerCase() ? 0.5 : levenshtein(name, candidate)
    if (distance <= limit && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) / 2) return Number.POSITIVE_INFINITY
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      current.push(
        Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost),
      )
    }
    previous = current
  }
  return previous[b.length] as number
}
