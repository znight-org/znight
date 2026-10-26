/**
 * Message type patterns of `@OnMessage(type)`, with the semantics of the runtime handler selection
 * (`consumers.ts`): a type containing `*` is a pattern where `*` matches any sequence of characters;
 * any other type is matched exactly. Exact types are tried first, then patterns in declaration order.
 */

/** Whether `type` is a pattern (contains `*`). */
export function isPattern(type: string): boolean {
  return type.includes('*')
}

/** Whether `type` matches `pattern` (`*` matches any sequence of characters, the runtime semantics). */
export function matchesPattern(pattern: string, type: string): boolean {
  return covers(pattern, type, false)
}

/**
 * Whether every message type matched by `inner` is also matched by `outer`, so that `inner`, tried
 * after `outer`, can never be selected. The check is sound (never reports a pattern that can be
 * selected): `outer` must match `inner` where each `*` of `inner` can only be consumed by a `*` of
 * `outer`.
 */
export function patternCovers(outer: string, inner: string): boolean {
  return covers(outer, inner, true)
}

/** Glob matching of `subject` by `pattern`; with `starsAreWildcards`, `*` of `subject` only match `*` of `pattern`. */
function covers(pattern: string, subject: string, starsAreWildcards: boolean): boolean {
  const p = collapseStars(pattern)
  const s = starsAreWildcards ? collapseStars(subject) : subject
  // previous[j]: p[0, i - 1) matches s[0, j)
  let previous: boolean[] = new Array<boolean>(s.length + 1).fill(false)
  previous[0] = true
  for (let i = 1; i <= p.length; i++) {
    const char = p[i - 1]
    const current: boolean[] = new Array<boolean>(s.length + 1).fill(false)
    current[0] = char === '*' && previous[0] === true
    for (let j = 1; j <= s.length; j++) {
      if (char === '*') {
        current[j] = previous[j] === true || current[j - 1] === true
      } else {
        const subjectChar = s[j - 1]
        current[j] = previous[j - 1] === true && subjectChar === char && !(starsAreWildcards && subjectChar === '*')
      }
    }
    previous = current
  }
  return previous[s.length] === true
}

/** `a**b` → `a*b` (same language). */
function collapseStars(pattern: string): string {
  return pattern.replace(/\*{2,}/g, '*')
}
