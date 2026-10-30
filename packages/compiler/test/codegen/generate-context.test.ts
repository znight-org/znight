/**
 * `GenerateContext` contract: imports, tokens, bindings, constants, and every failure of an
 * extension (throwing, invalid nodes, bad imports, syntax errors) reported naming the extension.
 */
import type { CompilerExtension, GenerateContext, GenNode } from '../../src/index.ts'

import { compile } from '../../src/compiler.ts'
import { tempApp } from '../analysis/helpers.ts'
import { render } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const app = tempApp({
  'node_modules/@acme/mark/package.json': JSON.stringify({
    name: '@acme/mark',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
    znight: { apiVersion: 1, provides: [{ export: 'Tool', plugin: 'AcmePlugin' }] },
  }),
  'node_modules/@acme/mark/index.d.ts': [
    'export declare function Mark(...args: unknown[]): ClassDecorator',
    'export declare function helper(value: unknown): unknown',
    'export declare class Tool {}',
  ].join('\n'),
  'node_modules/@acme/mark/index.js':
    'export const Mark = () => () => {}\nexport const helper = v => v\nexport class Tool {}\n',
  'src/model.ts': 'export interface Shape { area(): number }\n',
  'src/hidden.ts': 'class Hidden {}\nexport const HIDDEN_REF = Hidden\n',
  'src/marked.ts': `
import { Injectable } from '@znight/core'
import { Mark, type Tool } from '@acme/mark'
import type { Shape } from './model.ts'

@Injectable()
export class Square implements Shape {
  area(): number {
    return 4
  }
}

@Mark('first', Square)
export class Marked {
  constructor(readonly tool: Tool) {}
}
`,
})
afterAll(() => app.cleanup())

type Generate = (ctx: GenerateContext<{ readonly identity: string }>) => GenNode | undefined

function extension(
  name: string,
  generate: Generate,
  options: { factory?: boolean } = {},
): CompilerExtension<{
  readonly identity: string
}> {
  return {
    apiVersion: 1,
    name,
    decorators: { '@acme/mark#Mark': { targets: ['class'], params: ['static'], rest: 'value' } },
    analyzeClass(cls, ctx) {
      if (options.factory) {
        ctx.registerProvider(cls, {
          factory: { deps: [{ type: '@acme/mark#Tool' }], generate: (g, input) => g.construct(input.cls) },
        })
      } else {
        ctx.registerProvider(cls)
      }
      ctx.store({ identity: cls.identity })
    },
    generate,
  }
}

async function run(...extensions: CompilerExtension<{ readonly identity: string }>[]) {
  const result = await compile({
    root: app.root,
    conditions: ['@znight/source'],
    extensions: extensions as never,
    mode: 'build',
  })
  return { ...result, text: render(app.root, result.diagnostics) }
}

describe('GenerateContext', () => {
  it('imports values, types and package exports, resolves tokens, bindings and providers', async () => {
    let seen: Record<string, unknown> = {}
    const result = await run(
      extension('ok', ctx => {
        const identity = ctx.stored[0]?.identity as string
        seen = {
          token: ctx.tokenOf(identity),
          alias: ctx.tokenOf('src/model.ts#Shape'),
          external: ctx.tokenOf('@acme/mark#Tool'),
          unknown: ctx.tokenOf('src/nope.ts#Nope'),
          provider: ctx.provider(identity)?.displayName,
          missing: ctx.provider('src/nope.ts#Nope'),
          extension: ctx.extension,
        }
        return ctx.obj({
          cls: ctx.importValue(identity),
          type: ctx.arrow(
            [
              ['m', ctx.importType(identity)],
              ['s', ctx.importType('src/model.ts#Shape')],
            ],
            m => m,
          ),
          helper: ctx.call(ctx.importFrom('@acme/mark', 'helper'), [1]),
          member: ctx.member(ctx.importFrom('@acme/mark', 'helper'), 'name', 'length'),
          shared: ctx.constant('shared', ctx.arr([1, 2]), { type: ctx.code`readonly number[]` }),
          again: ctx.constant('shared', ctx.arr([3])),
          none: undefined,
          template: ctx.code`${ctx.importValue(identity)}.name + ${"'"}`,
          block: ctx.arrow(['x'], x => ctx.code`{ const y = ${x}; return y }`),
          object: ctx.arrow([], () => ctx.obj({ a: 1 })),
          operand: ctx.member(ctx.code`${1} + ${2}`, 'toString'),
        })
      }),
    )
    expect(result.text).toBe('')
    expect(seen).toEqual({
      token: 'src/marked.ts#Marked',
      alias: 'src/marked.ts#Square',
      external: '@acme/mark#Tool',
      unknown: undefined,
      provider: 'Marked',
      missing: undefined,
      extension: 'ok',
    })
    expect(result.code).toContain("import type { Shape } from '../model.js'")
    expect(result.code).toContain("import { helper } from '@acme/mark'")
    expect(result.code).toContain('const shared: readonly number[] = [1, 2]')
    expect(result.code).toContain("['again']: shared,")
    expect(result.code).toContain("['type']: (m: Marked, s: Shape) => m,")
    expect(result.code).toContain("['member']: helper.name.length,")
    expect(result.code).toContain("['none']: undefined,")
    expect(result.code).toContain("['template']: Marked.name + '\\'',")
    expect(result.code).toContain("['block']: x => { const y = x; return y },")
    expect(result.code).toContain("['object']: () => ({ ['a']: 1 }),")
    expect(result.code).toContain("['operand']: (1 + 2).toString,")
  })

  it('prints blocks one statement per line and keeps their locals free of imports and constants', async () => {
    const result = await run(
      extension('blocks', ctx => {
        const helper = ctx.importFrom('@acme/mark', 'helper')
        const marked = ctx.importValue(ctx.stored[0]?.identity as string)
        return ctx.obj({
          run: ctx.arrow(['x'], x =>
            ctx.block(['helper', 'Marked'], (local, other) => [
              ctx.code`const ${local} = ${ctx.call(helper, [x])}`,
              ctx.code`const ${other} = ${marked}`,
              ctx.code`return ${ctx.arr([local, other])}`,
            ]),
          ),
          empty: ctx.arrow([], () => ctx.block([], () => [])),
        })
      }),
    )
    expect(result.text).toBe('')
    expect(result.code).toContain("import { helper as helper$1 } from '@acme/mark'")
    expect(result.code).toContain("import { Marked as Marked$1, Square } from '../marked.js'")
    expect(result.code).toContain('factory: d => new Marked$1(d[0]),')
    expect(result.code).toContain(
      [
        "      ['run']: x => {",
        '        const helper = helper$1(x)',
        '        const Marked = Marked$1',
        '        return [helper, Marked]',
        '      },',
        "      ['empty']: () => {},",
      ].join('\n'),
    )
  })

  it('emits only the constants (and their imports) reachable from the metadata', async () => {
    const result = await run(
      extension('constants', ctx => {
        const toolType = ctx.importFrom('@acme/mark', 'Tool', { type: true })
        const base = ctx.constant('base', ctx.arr([1]), { type: ctx.code`readonly number[]` })
        const used = ctx.constant('used', ctx.code`[...${base}, 2]`)
        const orphan = ctx.constant('orphan', ctx.lit('x'), { type: toolType })
        ctx.constant('unusedChain', ctx.code`${orphan}.length`)
        return ctx.obj({ used })
      }),
    )
    expect(result.text).toBe('')
    expect(result.code).toContain('const base: readonly number[] = [1]\nconst used = [...base, 2]\n')
    expect(result.code).not.toContain('orphan')
    expect(result.code).not.toContain('unusedChain')
    expect(result.code).not.toContain("from '@acme/mark'")
  })

  it('omits the section when generate() returns undefined and drops unused factory parameters', async () => {
    const result = await run(extension('silent', () => undefined, { factory: true }))
    expect(result.text).toBe('')
    expect(result.code).not.toContain('extensions:')
    expect(result.code).toContain('factory: () => new Marked(),')
  })

  it('reports an extension that throws', async () => {
    const result = await run(
      extension('boom', () => {
        throw new Error('kaboom')
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.text).toContain(
      "ZNIGHT018: Compiler extension 'boom' (generating its metadata section) failed: kaboom",
    )
    expect(result.code).toContain('throw new ZnightError(')
  })

  it('reports forged and invalid nodes', async () => {
    const forged = await run(extension('forger', () => ({ kind: 'gen:object', entries: [] }) as unknown as GenNode))
    expect(forged.text).toContain(
      "ZNIGHT018: Compiler extension 'forger' (generating its metadata section) produced an invalid node (a forged 'gen:object' object)",
    )
    const nested = await run(
      extension('nested', ctx => ctx.arr([{ kind: 'gen:literal', value: 1 } as unknown as GenNode])),
    )
    expect(nested.text).toContain("produced an invalid node (a forged 'gen:literal' object)")
  })

  it('reports syntax errors of code templates as compiler bugs naming the extension', async () => {
    const result = await run(extension('broken-syntax', ctx => ctx.code`{ oops: ${1} ]`))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Internal compiler error: the generated module has a syntax error')
    expect(result.text).toContain("in the code produced by compiler extension 'broken-syntax'")
  })

  it('reports imports that cannot be routed, type-only values and bad module specifiers', async () => {
    const notExported = await run(extension('hidden', ctx => ctx.importValue('src/hidden.ts#Hidden')))
    expect(notExported.text).toContain(
      "ZNIGHT005: Compiler extension 'hidden' (generating its metadata section) cannot import src/hidden.ts#Hidden in the generated module: 'Hidden' is not exported by src/hidden.ts",
    )
    expect(notExported.text).toContain('= hint: Export it')

    const typeOnly = await run(extension('types', ctx => ctx.importValue('src/model.ts#Shape')))
    expect(typeOnly.text).toContain('uses src/model.ts#Shape as a value, but it only exists as a type')

    const missing = await run(extension('missing', ctx => ctx.importFrom('@acme/not-installed', 'x')))
    expect(missing.text).toContain("'@acme/not-installed' cannot be resolved from the generated module")

    const relative = await run(extension('relative', ctx => ctx.importFrom('./local.js', 'x')))
    expect(relative.text).toContain('importFrom() takes a package specifier')

    const badConstant = await run(extension('constants', ctx => ctx.constant('not valid', 1)))
    expect(badConstant.text).toContain('constant(): invalid name')

    const notAnIdentity = await run(extension('identity', ctx => ctx.importValue('Square')))
    expect(notAnIdentity.text).toContain("'Square' is not a canonical identity")
  })

  it('reports custom factories that throw, naming the provider', async () => {
    const result = await run({
      ...extension('factory-boom', () => undefined),
      analyzeClass(cls, ctx) {
        ctx.registerProvider(cls, {
          factory: {
            deps: [],
            generate: () => {
              throw new Error('no factory today')
            },
          },
        })
      },
    })
    expect(result.text).toContain(
      "Compiler extension 'factory-boom' (generating the factory of Marked) failed: no factory today",
    )
  })
})
