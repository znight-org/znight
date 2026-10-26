/**
 * Naming helpers shared by `znight new` and `znight g`: case conversions, npm package names,
 * "did you mean" suggestions.
 */

/** Splits an identifier into lower-case words: `UserProfile`, `user_profile`, `HTTPClient` → words. */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(word => word !== '')
    .map(word => word.toLowerCase())
}

/** `user-profile` */
export function kebabCase(name: string): string {
  return words(name).join('-')
}

/** `UserProfile` */
export function pascalCase(name: string): string {
  return words(name)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
}

/** `userProfile` */
export function camelCase(name: string): string {
  const pascal = pascalCase(name)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/** `USER_PROFILE` */
export function constantCase(name: string): string {
  return words(name)
    .map(word => word.toUpperCase())
    .join('_')
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

/**
 * Validates an npm package name (lower case, URL-safe, at most 214 characters, optional scope).
 * Returns a problem description, or `undefined` when the name is valid.
 */
export function validatePackageName(name: string): string | undefined {
  if (name === '') return 'the name cannot be empty'
  if (name.length > 214) return 'the name cannot be longer than 214 characters'
  if (name !== name.trim()) return 'the name cannot start or end with spaces'
  if (name !== name.toLowerCase()) return 'the name must be lower case'
  if (name.startsWith('.') || name.startsWith('_')) return 'the name cannot start with "." or "_"'
  if (!PACKAGE_NAME.test(name)) {
    return 'the name may only contain lower-case letters, digits, "-", ".", "_" and "~" (and an optional @scope/)'
  }
  return undefined
}

/** Turns any string into a valid package name candidate: `My App!` → `my-app`. */
export function toPackageName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[._]+/, '')
    .replace(/[^a-z0-9@/._~-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** The unscoped part of a package name: `@acme/api` → `api`. */
export function unscopedName(name: string): string {
  const slash = name.indexOf('/')
  return name.startsWith('@') && slash !== -1 ? name.slice(slash + 1) : name
}

/** Levenshtein distance (small strings only). */
export function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] ?? 0
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] ?? 0
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost)
      diagonal = above
    }
  }
  return previous[b.length] ?? 0
}

/** The closest candidate within a distance of `max(2, length / 3)`, if any. */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  const limit = Math.max(2, Math.floor(input.length / 3))
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance && distance <= limit) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}
