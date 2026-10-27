import type {
  ClassInfo,
  CompilerExtension,
  NamedShape,
  Shape,
  ShapeResult,
  TypeHelpers,
  ValidateContext,
  ZnightOptions,
} from '../../src/index.ts'
import type { FixtureAnalysis } from '../analysis/helpers.ts'

import { analyzeRoot } from '../analysis/helpers.ts'

/** Declarations of the `@acme/mark` test package (marker decorators read by {@link markExtension}). */
export const MARK_PACKAGE: Record<string, string> = {
  'node_modules/@acme/mark/package.json': JSON.stringify({
    name: '@acme/mark',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  }),
  'node_modules/@acme/mark/index.d.ts': [
    'export declare function Mark(): ClassDecorator',
    'export declare function Arg(): ParameterDecorator',
    'export declare function Returns<T = unknown>(status: number): MethodDecorator',
    '',
  ].join('\n'),
  'node_modules/@acme/mark/index.js': 'export const Mark = () => () => {}\n',
}

/** What the test extension saw in `validate`. */
export interface Seen {
  readonly classes: Map<string, ClassInfo>
  types: TypeHelpers | undefined
  validate: ValidateContext | undefined
}

/** An extension marking classes with `@Mark()` (registered as providers) and capturing the validate context. */
export function markExtension(seen: Seen, validate?: (ctx: ValidateContext) => void): CompilerExtension<ClassInfo> {
  return {
    apiVersion: 1,
    name: 'mark',
    decorators: {
      '@acme/mark#Mark': { targets: ['class'], params: [] },
      '@acme/mark#Arg': { targets: ['parameter'], params: [] },
      '@acme/mark#Returns': { targets: ['method'], params: ['static'] },
    },
    analyzeClass(cls, ctx) {
      seen.classes.set(cls.name, cls)
      if (cls.decorators.some(decorator => decorator.identity === '@acme/mark#Mark')) {
        ctx.registerProvider(cls)
      }
      ctx.store(cls)
    },
    validate(ctx) {
      seen.types = ctx.types
      seen.validate = ctx as ValidateContext
      validate?.(ctx as ValidateContext)
    },
  }
}

/** Analyses `root` with {@link markExtension}. */
export async function analyzeMarked(
  root: string,
  validate?: (ctx: ValidateContext) => void,
  options: ZnightOptions = {},
): Promise<{ readonly result: FixtureAnalysis; readonly seen: Seen }> {
  const seen: Seen = { classes: new Map(), types: undefined, validate: undefined }
  const result = await analyzeRoot(root, { ...options, extensions: [markExtension(seen, validate)] })
  return { result, seen }
}

/** Compact TypeScript-like rendering of a shape (named shapes as `@key`). */
export function printShape(shape: Shape): string {
  switch (shape.kind) {
    case 'literal':
      return JSON.stringify(shape.value)
    case 'array': {
      const items = printShape(shape.items)
      return shape.items.kind === 'union' || shape.items.kind === 'intersection' ? `(${items})[]` : `${items}[]`
    }
    case 'tuple': {
      const items = shape.items.map((item, index) => `${printShape(item)}${index >= shape.minItems ? '?' : ''}`)
      if (shape.rest) {
        items.push(`...${printShape(shape.rest)}[]`)
      }
      return `[${items.join(', ')}]`
    }
    case 'object': {
      const entries = shape.properties.map(
        property =>
          `${property.readonly ? 'readonly ' : ''}${property.name}${property.optional ? '?' : ''}: ${printShape(property.shape)}`,
      )
      if (shape.additional) {
        entries.push(`[string]: ${printShape(shape.additional)}`)
      }
      return `{ ${entries.join('; ')} }`
    }
    case 'union':
      return shape.members.map(printShape).join(' | ')
    case 'intersection':
      return shape.members.map(printShape).join(' & ')
    case 'named':
      return `@${shape.key}`
    case 'schema':
      return `schema(${shape.ref.text}, ${shape.io})`
    case 'reference':
      return `ref(${shape.name}${shape.typeArgs.length > 0 ? `<${shape.typeArgs.map(printShape).join(', ')}>` : ''}/${shape.explicitTypeArgs})`
    case 'opaque':
      return `opaque(${shape.reason}: ${shape.text})`
    default:
      return shape.kind
  }
}

/** Root, named shapes and issues of a result, one per line. */
export function printResult(result: ShapeResult): string {
  const lines = [printShape(result.root)]
  for (const named of result.named.values()) {
    lines.push(`${named.key} (${named.declaration}) = ${printShape(named.shape)}`)
  }
  for (const issue of result.issues) {
    lines.push(`! ${issue.reason} at ${issue.named ?? '<root>'} ${issue.path || '<root>'}: ${issue.text}`)
  }
  return lines.join('\n')
}

/** The named shape with a key, failing loudly. */
export function namedOf(result: ShapeResult, key: string): NamedShape {
  const found = result.named.get(key)
  if (!found) {
    throw new Error(`no named shape ${key}; named: ${[...result.named.keys()].join(', ')}`)
  }
  return found
}
