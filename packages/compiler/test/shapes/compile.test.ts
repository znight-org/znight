/**
 * `TypeHelpers.shape()` through `compile()`: available in the generate context, files read are part
 * of `watchFiles`, and an incremental compile after editing an interface of another file gives the
 * new shape (RFC 0002 §13.3, "Watch").
 */
import type { ClassInfo, CompilerExtension } from '../../src/index.ts'

import { compile, createCompiler } from '../../src/compiler.ts'
import { tempApp } from '../analysis/helpers.ts'
import { MARK_PACKAGE, printShape } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

/** Emits the shape of every method return type of the marked classes into its metadata section. */
const shapes: CompilerExtension<ClassInfo> = {
  apiVersion: 1,
  name: 'shapes',
  decorators: { '@acme/mark#Mark': { targets: ['class'], params: [] } },
  analyzeClass(cls, ctx) {
    ctx.registerProvider(cls)
    ctx.store(cls)
  },
  generate(ctx) {
    const entries: Record<string, ReturnType<typeof ctx.lit>> = {}
    for (const cls of ctx.stored) {
      for (const method of cls.methods) {
        const result = ctx.types.shape({ returnOf: method })
        entries[`${cls.name}.${method.name}`] = ctx.lit(
          [
            printShape(result.root),
            ...[...result.named.values()].map(named => `${named.key}=${printShape(named.shape)}`),
          ].join('\n'),
        )
      }
    }
    return ctx.obj(entries)
  },
}

const MODEL_V1 = `export interface Book {
  title: string
}
`
const MODEL_V2 = `export interface Book {
  title: string
  isbn?: string
}
`

describe('shapes in compile()', () => {
  it('are available during generation and deterministic', async () => {
    const app = tempApp({
      ...MARK_PACKAGE,
      'shared/model.ts': MODEL_V1,
      'src/routes.ts': `import { Mark } from '@acme/mark'
import type { Book } from '../shared/model.ts'
@Mark()
export class Routes {
  list(): Promise<Book[]> {
    return null!
  }
}
`,
    })
    try {
      const first = await compile({ root: app.root, extensions: [shapes] })
      expect(first.ok).toBe(true)
      expect(first.code).toContain(
        "['Routes.list']: '@shared/model.ts#Book[]\\nshared/model.ts#Book={ title: string }'",
      )
      expect(first.watchFiles).toContain(`${app.root}/shared/model.ts`)
      const second = await compile({ root: app.root, extensions: [shapes] })
      expect(second.code).toBe(first.code)
    } finally {
      app.cleanup()
    }
  })

  it('an incremental compile after editing an interface of another file gives the new shape', async () => {
    const app = tempApp({
      ...MARK_PACKAGE,
      'shared/model.ts': MODEL_V1,
      'src/routes.ts': `import { Mark } from '@acme/mark'
import type { Book } from '../shared/model.ts'
@Mark()
export class Routes {
  one(): Book {
    return null!
  }
}
`,
    })
    try {
      const compiler = createCompiler({ root: app.root, extensions: [shapes] })
      const before = await compiler.compile()
      expect(before.code).toContain('shared/model.ts#Book={ title: string }')
      const file = app.write('shared/model.ts', MODEL_V2)
      const after = await compiler.compile({ changed: [file] })
      expect(after.code).toContain('shared/model.ts#Book={ title: string; isbn?: string }')
    } finally {
      app.cleanup()
    }
  })
})
