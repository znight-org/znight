/**
 * The compiler contract for other extensions (README, "Compiler contract for other extensions"):
 * data stored by the http extension and read by others through `graph.extensions` (`@znight/openapi`).
 */
import { analyzeApp, cleanupApps, httpDiagnostics, tempApp } from './helpers.ts'
import { afterAll, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

it('stores static parameter defaults and the identity of route decorators', async () => {
  const app = tempApp({
    'src/shared.ts': `
export const PAGE_SIZE = 20
export function today(): string { return new Date().toISOString() }
`,
    'src/flags.ts': `
import { createRouteDecorator } from '@znight/http'
export const Beta = createRouteDecorator('beta')
`,
    'src/books.controller.ts': `
import { Controller, Get, Query } from '@znight/http'
import { Beta } from './flags.ts'
import { PAGE_SIZE, today } from './shared.ts'

@Controller('/books')
export class BookController {
  @Get()
  @Beta()
  list(
    @Query('page') page = 1,
    @Query('size') size: number = PAGE_SIZE,
    @Query('sort') sort: 'asc' | 'desc' = 'asc',
    @Query('tags') tags: string[] = [],
    @Query('since') since: string = today(),
    @Query('q') q?: string,
  ) {
    return { page, size, sort, tags, since, q }
  }
}
`,
  })
  const result = await analyzeApp(app.root)
  expect(httpDiagnostics(result)).toEqual([])
  const route = result.controllers[0]?.routes[0]
  expect(route?.params.map(param => [param.key, param.defaultValue])).toEqual([
    ['page', 1],
    ['size', 20],
    ['sort', 'asc'],
    ['tags', []],
    ['since', undefined],
    ['q', undefined],
  ])
  expect(route?.params.some(param => 'defaultValue' in param && param.defaultValue === undefined)).toBe(false)
  expect(route?.meta.map(entry => [entry.identity, entry.decorator, entry.group, entry.required])).toEqual([
    ['src/flags.ts#Beta', 'Beta', 'beta', false],
  ])
})
