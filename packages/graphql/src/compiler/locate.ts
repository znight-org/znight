/**
 * Source locations of diagnostics. Computed only when a diagnostic is reported: the happy path
 * never reads source text.
 */
import type { Location, MethodInfo, Project } from '@znight/compiler'

/** From the member name: `name?: ` or `name(): ` (a getter), up to the annotation. */
const MEMBER_HEAD = /^(?:[\w$]+|'[^']*'|"[^"]*")\s*\??\s*(?:\(\s*\))?\s*:\s*/

const OPENING = new Set(['(', '[', '{', '<'])
const CLOSING = new Set([')', ']', '}', '>'])

/**
 * The type annotation of a property, a property signature or a getter (`get x(): T`), from the
 * location of the member (its name); the member itself when the annotation cannot be found.
 */
export function annotationLocation(project: Project, member: Location | undefined): Location | undefined {
  if (member === undefined) return undefined
  const file = project.getFile(member.file)
  if (file === undefined) return member
  const text = file.text
  const head = MEMBER_HEAD.exec(text.slice(member.start, member.start + 256))
  if (head === null) return member
  const start = member.start + head[0].length
  let depth = 0
  let end = start
  for (let index = start; index < text.length; index++) {
    const char = text[index] as string
    if (char === '=' && text[index + 1] === '>') {
      index++
      continue
    }
    // a getter body or an initializer after the annotation
    if (depth === 0 && end > start && (char === '{' || char === '=')) break
    if (OPENING.has(char)) depth++
    else if (CLOSING.has(char)) {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && (char === ';' || char === ',')) break
    else if (depth === 0 && char === '\n' && !/^\s*[|&]/.test(text.slice(index + 1, index + 64))) break
    if (!/\s/.test(char)) end = index + 1
  }
  return end > start ? file.location({ start, end }) : member
}

/**
 * The return type annotation of a method, from the location of its name: after the parameter list
 * (balanced brackets), `: T` up to the body; `undefined` when it cannot be found.
 */
export function returnTypeLocation(project: Project, method: MethodInfo): Location | undefined {
  const file = project.getFile(method.location.file)
  if (file === undefined) return undefined
  const text = file.text
  let index = text.indexOf('(', method.location.end)
  if (index === -1) return undefined
  let depth = 0
  for (; index < text.length; index++) {
    const char = text[index] as string
    if (OPENING.has(char)) depth++
    else if (CLOSING.has(char) && --depth === 0) break
  }
  const head = /^\s*:\s*/.exec(text.slice(index + 1, index + 64))
  if (head === null) return undefined
  const start = index + 1 + head[0].length
  let end = start
  depth = 0
  for (let cursor = start; cursor < text.length; cursor++) {
    const char = text[cursor] as string
    if (char === '=' && text[cursor + 1] === '>') {
      cursor++
      continue
    }
    if (depth === 0 && (char === '{' || char === ';') && end > start) break
    if (OPENING.has(char)) depth++
    else if (CLOSING.has(char)) {
      if (depth === 0) break
      depth--
    }
    if (!/\s/.test(char)) end = cursor + 1
  }
  return end > start ? file.location({ start, end }) : undefined
}
