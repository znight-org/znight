/**
 * Job name grammar and "did you mean" suggestions, shared by the compiler extension and the runtime.
 * This module is **pure**: no imports, no I/O, no global state.
 */

/** Grammar of job names: logs, metrics, lock keys and the registry use them as is. */
export const JOB_NAME_PATTERN: RegExp = /^[\w$][\w.:$-]{0,127}$/

/** Human-readable form of {@link JOB_NAME_PATTERN}, for messages. */
export const JOB_NAME_RULE =
  'job names start with a letter, a digit, _ or $, then use letters, digits and _ . : $ - (128 characters at most)'

/** Whether `name` is a valid job name. */
export function isJobName(name: unknown): name is string {
  return typeof name === 'string' && JOB_NAME_PATTERN.test(name)
}

/**
 * The candidate closest to `name` (typos, case: `timezone` → `timeZone`, `Europe/Pari` →
 * `Europe/Paris`), when it is close enough to be a plausible typo.
 */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  const lower = name.toLowerCase()
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1
  for (const candidate of candidates) {
    const other = candidate.toLowerCase()
    if (other === lower) return candidate
    if (Math.abs(other.length - lower.length) >= bestDistance) continue
    const distance = editDistance(lower, other)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution)
    }
    previous = current
  }
  return previous[b.length] ?? 0
}
