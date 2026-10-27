/**
 * Component names and JSON Schemas of TypeScript declarations next to Standard Schema slots,
 * through `compile()` and `buildOpenApiDocument`: name conflicts found at compile time whatever the
 * route order, generic instantiations, discriminated unions.
 */
import type { OpenApiObject } from '../../src/index.ts'

import { buildOpenApiDocument } from '../../src/index.ts'
import { cleanupApps, compileApp, loadApp, render, tempApp, validateDocument } from '../support/apps.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const MAIN = `import { OpenApiPlugin } from '@znight/openapi'\nexport const plugin = OpenApiPlugin\n`

/** Compiles `files`: the openapi diagnostics, and the assembled document when the compile succeeds. */
async function assemble(
  files: Record<string, string>,
): Promise<{ lines: string[]; document: OpenApiObject | undefined }> {
  const app = tempApp({ 'src/main.ts': MAIN, ...files })
  const result = await compileApp(app)
  const lines = render(
    app,
    result.diagnostics.filter(diagnostic => /^ZNIGHT03\d$/.test(diagnostic.code)),
  )
  if (result.diagnostics.some(diagnostic => diagnostic.severity === 'error')) return { lines, document: undefined }
  const built = await buildOpenApiDocument(await loadApp(app))
  expect(await validateDocument(built.document)).toMatchObject({ valid: true })
  return { lines, document: built.document }
}

describe('TypeScript declarations and Standard Schemas', () => {
  const files = (first: string, second: string): Record<string, string> => ({
    'src/model.ts': 'export interface User { id: number; name: string }\n',
    'src/schemas.ts': "import { z } from 'zod'\nexport const User = z.object({ name: z.string() })\n",
    'src/controllers.ts': `import { Body, Controller, Get, Post } from '@znight/http'
import type { User as UserModel } from './model.ts'
import { User } from './schemas.ts'
@Controller('/${first}')
export class AController {
  @Get() get(): UserModel { return null! }
}
@Controller('/${second}')
export class BController {
  @Post() post(@Body(User) user: unknown): void {}
}
`,
  })

  it('reports a declaration and a schema with one name at compile time, whatever the route order', async () => {
    const message =
      'error ZNIGHT034 src/model.ts:1:18 Two schemas are named "User" in the OpenAPI document: the interface User and the schema src/schemas.ts#User'
    expect((await assemble(files('a', 'b'))).lines).toEqual([message])
    expect((await assemble(files('b', 'a'))).lines).toEqual([message])
  })

  it('documents an interface merged with the schema it is inferred from by the schema', async () => {
    const { lines, document } = await assemble({
      'src/schemas.ts': `import { z } from 'zod'
export const User = z.object({ id: z.number(), name: z.string().default('anonymous') })
export interface User extends z.infer<typeof User> {}
`,
      'src/user.controller.ts': `import { Body, Controller, Get, Post } from '@znight/http'
import { User } from './schemas.ts'
@Controller('/users')
export class UserController {
  @Post() create(@Body(User) user: User): void {}
  @Get() get(): User { return null! }
}
`,
    })
    expect(lines).toEqual([])
    const schemas = document?.components?.schemas ?? {}
    expect(Object.keys(schemas).filter(name => name.startsWith('User'))).toEqual(['User', 'UserInput'])
    expect(schemas['User']).toMatchObject({ required: ['id', 'name'], additionalProperties: false })
    expect(schemas['UserInput']).toMatchObject({ required: ['id'] })
    expect(document?.paths?.['/users']?.get?.responses?.['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
    })
  })
})

describe('generic declarations', () => {
  it('gives distinct names to instantiations with anonymous or ambiguous type arguments', async () => {
    const { lines, document } = await assemble({
      'src/types.ts': `export interface Box<T> { value: T }
export interface Book { title: string }
export interface BookArray { count: number }
`,
      'src/box.controller.ts': `import { Controller, Get } from '@znight/http'
import type { Book, BookArray, Box } from './types.ts'
@Controller('/box')
export class BoxController {
  @Get('/a') a(): Box<{ a: string }> { return null! }
  @Get('/b') b(): Box<{ b: number }> { return null! }
  @Get('/c') c(): Box<Book[]> { return null! }
  @Get('/d') d(): Box<BookArray> { return null! }
  @Get('/e') e(): Box<Book> { return null! }
}
`,
    })
    expect(lines).toEqual([])
    const names = Object.keys(document?.components?.schemas ?? {}).filter(name => name.startsWith('Box'))
    expect(names).toHaveLength(5)
    expect(names).toContain('Box_Book')
    expect(names).toContain('Box_BookArray')
    expect(names.filter(name => /^Box_object_[0-9a-f]{8}$/.test(name))).toHaveLength(2)
    expect(names.filter(name => /^Box_BookArray_[0-9a-f]{8}$/.test(name))).toHaveLength(1)
    const refOf = (path: string): unknown => {
      const response = document?.paths?.[path]?.get?.responses?.['200'] as
        | { content: Record<string, { schema: unknown }> }
        | undefined
      return response?.content['application/json']?.schema
    }
    expect(refOf('/box/a')).not.toEqual(refOf('/box/b'))
    expect(refOf('/box/c')).not.toEqual(refOf('/box/d'))
  })

  it('names the same instantiation the same way in two compiles', async () => {
    const files = {
      'src/types.ts': 'export interface Page<T> { items: T[] }\n',
      'src/page.controller.ts': `import { Controller, Get } from '@znight/http'
import type { Page } from './types.ts'
@Controller('/p')
export class PageController {
  @Get() list(): Page<{ id: string }> { return null! }
}
`,
    }
    const first = Object.keys((await assemble(files)).document?.components?.schemas ?? {})
    const second = Object.keys((await assemble(files)).document?.components?.schemas ?? {})
    expect(first).toEqual(second)
    expect(first.some(name => /^Page_object_[0-9a-f]{8}$/.test(name))).toBe(true)
  })
})

describe('discriminated unions', () => {
  it('writes a discriminator only when a mapping covers every member', async () => {
    const { lines, document } = await assemble({
      'src/event.controller.ts': `import { Controller, Get } from '@znight/http'
export interface Created { type: 'created'; id: string }
export interface Deleted { type: 'deleted'; id: string }
export type Named = Created | Deleted
export type Mixed = Created | { type: 'archived'; id: string }
export interface Events { named: Named; mixed: Mixed; inline: { type: 'a'; x: number } | { type: 'b'; y: number } }
@Controller('/events')
export class EventController {
  @Get() get(): Events { return null! }
}
`,
    })
    expect(lines).toEqual([])
    const schemas = document?.components?.schemas ?? {}
    expect(schemas['Named']).toMatchObject({
      discriminator: {
        propertyName: 'type',
        mapping: { created: '#/components/schemas/Created', deleted: '#/components/schemas/Deleted' },
      },
    })
    expect(schemas['Mixed']?.['oneOf']).toHaveLength(2)
    expect(schemas['Mixed']?.['discriminator']).toBeUndefined()
    const inline = (schemas['Events'] as { properties: Record<string, Record<string, unknown>> }).properties['inline']
    expect(inline?.['oneOf']).toHaveLength(2)
    expect(inline?.['discriminator']).toBeUndefined()
  })
})
