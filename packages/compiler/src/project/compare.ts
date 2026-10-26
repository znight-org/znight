/**
 * Locale-independent string comparison (UTF-16 code unit order), used for every deterministic
 * ordering of the compiler output. Never use `localeCompare`: its result depends on the ICU data
 * of the machine.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  return a < b ? -1 : 1
}
