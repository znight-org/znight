/**
 * The JSDoc vocabulary of the extension (RFC 0005 §5.14): descriptions, `@param`, `@deprecated`,
 * `@default`, `@gqlHidden` and `@gqlName`.
 */
import type { DocComment, DocTag } from '@znight/compiler'

import { DEFAULT_DEPRECATION_REASON } from '../names.ts'

/** The comment text (before the first tag), `undefined` when empty. */
export function descriptionOf(doc: DocComment | undefined): string | undefined {
  return doc === undefined || doc.text === '' ? undefined : doc.text
}

/** The first tag named `name`. */
export function tagOf(doc: DocComment | undefined, name: string): DocTag | undefined {
  return doc?.tags.find(tag => tag.name === name)
}

/** `@deprecated reason`: the reason (graphql-js' default one without text), `undefined` without the tag. */
export function deprecationOf(doc: DocComment | undefined): string | undefined {
  const tag = tagOf(doc, 'deprecated')
  if (tag === undefined) return undefined
  const reason = tag.text.trim()
  return reason === '' ? DEFAULT_DEPRECATION_REASON : reason
}

/** `true` with a `@gqlHidden` tag. */
export function isHidden(doc: DocComment | undefined): boolean {
  return tagOf(doc, 'gqlHidden') !== undefined
}

/**
 * The text of `@param name text` (also `@param {Type} name - text`), `undefined` when there is no
 * such tag or it has no text.
 */
export function paramDescription(doc: DocComment | undefined, name: string): string | undefined {
  for (const tag of doc?.tags ?? []) {
    if (tag.name !== 'param') continue
    const match = /^(?:\{[^}]*\}\s*)?\[?([\w$]+)(?:=[^\]]*)?\]?(?:\s+-)?(?:\s+([\s\S]*))?$/.exec(tag.text.trim())
    if (match?.[1] !== name) continue
    const text = match[2]?.trim()
    return text === undefined || text === '' ? undefined : text
  }
  return undefined
}

/** A `@default` value: JSON when it parses, the text otherwise (`@default title`). */
export function defaultTagValue(tag: DocTag): unknown {
  const text = tag.text.trim()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
