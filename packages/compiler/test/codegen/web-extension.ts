/**
 * A compiler extension written like a feature package's (`@fixture/web/compiler`): it only uses the
 * public extension API and exercises every `GenerateContext` feature (imports of values, types and
 * package helpers, tokens, typed arrows, `code` templates, constants shared between a custom
 * factory and the section, every kind of literal).
 */
import type { ArgInfo, ClassInfo, CompilerExtension, GenerateContext, GenNode } from '../../src/index.ts'

const ID = '@fixture/web#'

interface RouteData {
  readonly handler: string
  readonly path: string
  readonly schema: ArgInfo | undefined
  readonly params: number
}

interface FieldData {
  readonly property: string
  readonly env: string
  readonly default: unknown
}

export type WebData =
  | {
      readonly kind: 'controller'
      readonly cls: ClassInfo
      readonly path: string
      readonly guards: readonly string[]
      readonly routes: readonly RouteData[]
    }
  | { readonly kind: 'settings'; readonly cls: ClassInfo; readonly fields: readonly FieldData[] }

/** Literal values exercising the literal emitter (checked at runtime by the e2e test). */
export const LITERALS: Record<string, unknown> = {
  nan: Number.NaN,
  infinity: Number.POSITIVE_INFINITY,
  negativeInfinity: Number.NEGATIVE_INFINITY,
  negativeZero: -0,
  big: 12345678901234567890n,
  date: new Date(0),
  regexp: /a\/b[']/gi,
  text: 'it\'s "quoted"\n \t\\',
  nested: [undefined, null, { 'weird key': true, "it's": [1, 2] }],
  proto: JSON.parse('{"__proto__": 1}') as unknown,
}

function fieldsConstant(g: GenerateContext<unknown>, cls: ClassInfo, fields: readonly FieldData[]): GenNode {
  return g.constant(
    `${cls.name}$fields`,
    g.lit(fields.map(field => ({ property: field.property, env: field.env, default: field.default as never }))),
    { type: g.code`readonly ${g.importFrom('@fixture/web', 'FieldDefinition', { type: true })}[]` },
  )
}

export const webExtension = {
  apiVersion: 1,
  name: 'web',
  decorators: {
    [`${ID}Controller`]: { targets: ['class'], params: ['static'] },
    [`${ID}Get`]: { targets: ['method'], params: ['static', 'value'] },
    [`${ID}Guard`]: { targets: ['class'], params: [], rest: 'value' },
    [`${ID}Settings`]: { targets: ['class'], params: [] },
    [`${ID}Value`]: { targets: ['property'], params: ['static'] },
  },
  analyzeClass(cls, ctx) {
    const controller = cls.decorators.find(decorator => decorator.identity === `${ID}Controller`)
    if (controller) {
      ctx.registerProvider(cls)
      const guards = cls.decorators
        .filter(decorator => decorator.identity === `${ID}Guard`)
        .flatMap(decorator => decorator.args)
        .flatMap(arg => {
          const ref = ctx.resolveClassRef(arg, { from: cls, role: 'guard' })
          return ref ? [ref.token] : []
        })
      const routes = cls.methods.flatMap(method => {
        const get = method.decorators.find(decorator => decorator.identity === `${ID}Get`)
        return get
          ? [
              {
                handler: method.name,
                path: String(get.args[0]?.value ?? '/'),
                schema: get.args[1],
                params: method.params.length,
              },
            ]
          : []
      })
      ctx.store({ kind: 'controller', cls, path: String(controller.args[0]?.value ?? '/'), guards, routes })
    }
    if (cls.decorators.some(decorator => decorator.identity === `${ID}Settings`)) {
      const fields = cls.properties.flatMap(property => {
        const value = property.decorators.find(decorator => decorator.identity === `${ID}Value`)
        return value
          ? [{ property: property.name, env: String(value.args[0]?.value), default: property.initializer?.value }]
          : []
      })
      ctx.registerProvider(cls, {
        factory: {
          deps: [{ type: `${ID}Logger`, label: `logger of ${cls.displayName}` }],
          generate: (g, input) =>
            g.call(g.importFrom('@fixture/web', 'build'), [
              input.cls,
              input.deps[0] as GenNode,
              fieldsConstant(g, cls, fields),
            ]),
        },
      })
      ctx.store({ kind: 'settings', cls, fields })
    }
  },
  generate(ctx) {
    const controllers = ctx.stored.flatMap(data => {
      if (data.kind !== 'controller') {
        return []
      }
      const routes = data.routes.map(route => {
        const entries: [string, GenNode | string][] = [
          ['path', route.path],
          ['fullPath', `${data.path}${route.path}`],
          ['pattern', ctx.lit(new RegExp(`^${data.path}${route.path.replace(/:\w+/g, '([^/]+)')}$`))],
        ]
        if (route.schema?.ref) {
          entries.push(['schema', ctx.importValue(route.schema)])
        }
        const contextType = ctx.importFrom('@fixture/web', 'Context', { type: true })
        entries.push([
          'invoke',
          route.params === 0
            ? ctx.arrow(
                [
                  ['c', ctx.importType(data.cls)],
                  ['_context', contextType],
                ],
                c => ctx.call(ctx.member(c, route.handler)),
              )
            : ctx.arrow(
                [
                  ['c', ctx.importType(data.cls)],
                  ['context', contextType],
                ],
                (c, context) =>
                  ctx.call(ctx.member(c, route.handler), [
                    ctx.call(ctx.member(ctx.importFrom('@fixture/web', 'coerce'), 'number'), [
                      ctx.code`${context as GenNode}.params[${'id'}]`,
                      'param "id"',
                    ]),
                  ]),
              ),
        ])
        return ctx.obj(entries)
      })
      return [
        ctx.obj({
          token: ctx.tokenOf(data.cls) ?? null,
          path: data.path,
          guards: ctx.arr(data.guards),
          routes: ctx.arr(routes),
        }),
      ]
    })
    const settings = ctx.stored.flatMap(data =>
      data.kind === 'settings'
        ? [ctx.obj({ token: ctx.tokenOf(data.cls) ?? null, fields: fieldsConstant(ctx, data.cls, data.fields) })]
        : [],
    )
    return ctx.obj({
      controllers: ctx.arr(controllers),
      settings: ctx.arr(settings),
      literals: ctx.lit(LITERALS as never),
    })
  },
} satisfies CompilerExtension<WebData>
