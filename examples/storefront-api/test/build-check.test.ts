/**
 * "Try breaking it" (README): the mistakes that would make the documentation lie are build errors
 * or warnings, with a location. Each case copies the application into a temporary directory, breaks
 * one file, and compiles it with `compile()` of `@znight/compiler`, as `znight build`, `znight
 * generate` and `bun test` do.
 */
import type { Diagnostic } from '@znight/compiler'

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@znight/compiler'

import options from '../znight.config.js'
import { afterAll, describe, expect, test as it } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const copies: string[] = []

afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true })
})

/** A copy of the application (without its generated module), sharing its `node_modules`. */
function copyOfTheApp(): {
  root: string
  edit(file: string, from: string, to: string): void
  write(file: string, content: string): void
} {
  // the real path: diagnostics locate files by their real path (macOS: /var is /private/var)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'storefront-build-check-')))
  copies.push(root)
  cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true, filter: source => !source.includes('.znight') })
  for (const file of ['package.json', 'tsconfig.json']) cpSync(join(ROOT, file), join(root, file))
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  return {
    root,
    edit(file, from, to) {
      const path = join(root, file)
      const content = readFileSync(path, 'utf8')
      // keeps this test honest when the application changes
      if (!content.includes(from)) throw new Error(`${file} does not contain ${JSON.stringify(from)}`)
      writeFileSync(path, content.replace(from, to))
    },
    write(file, content) {
      writeFileSync(join(root, file), content)
    },
  }
}

/** The OpenAPI diagnostics (ZNIGHT030–039) of a compile: `severity code file:line message`. */
async function diagnose(root: string): Promise<{ lines: string[]; diagnostics: Diagnostic[] }> {
  const result = await compile({ ...options, root, conditions: ['@znight/source'], mode: 'test' })
  const diagnostics = result.diagnostics.filter(diagnostic => /^ZNIGHT03\d$/.test(diagnostic.code))
  const lines = diagnostics.map(({ severity, code, location, message }) => {
    const where = location === undefined ? '-' : `${relative(root, location.file)}:${location.line}`
    return `${severity} ${code} ${where} ${message}`
  })
  return { lines, diagnostics }
}

describe('try breaking it', () => {
  it('compiles the application as it is without OpenAPI diagnostics', async () => {
    const app = copyOfTheApp()

    expect((await diagnose(app.root)).lines).toEqual([])
  })

  it('ZNIGHT031: a handler whose return type is not annotated cannot be documented', async () => {
    const app = copyOfTheApp()
    app.edit(
      'src/catalog/product.controller.ts',
      "get(@Param('id', Id) id: string): ProductResponse {",
      "get(@Param('id', Id) id: string) {",
    )

    const { lines, diagnostics } = await diagnose(app.root)

    expect(lines).toEqual([
      expect.stringMatching(
        /^warning ZNIGHT031 src\/catalog\/product\.controller\.ts:\d+ The 200 response of GET \/products\/:id \(ProductController\.get\) cannot be documented: the handler has no return type annotation$/,
      ),
    ])
    expect(diagnostics[0]?.hints?.join('\n')).toContain('@ApiResponse')
  })

  it('ZNIGHT032: a bigint in a JSON response is an error (JSON.stringify throws on it)', async () => {
    const app = copyOfTheApp()
    app.edit('src/admin/admin.controller.ts', 'readonly revenueCents: number', 'readonly revenueCents: bigint')

    const { lines } = await diagnose(app.root)

    expect(lines).toEqual([
      expect.stringMatching(
        /^error ZNIGHT032 src\/admin\/admin\.controller\.ts:\d+ ShopStats\.revenueCents is a bigint/,
      ),
    ])
  })

  it('ZNIGHT033: two controllers with the same name give the same operation ids', async () => {
    const app = copyOfTheApp()
    app.write(
      'src/admin/product.controller.ts',
      `import { Controller, Get } from '@znight/http'
import { ApiSecurity } from '@znight/openapi'

import { ApiKey } from '../api.js'
import { Roles } from '../auth/auth.decorators.js'

/** The products, as the back office sees them. */
@Controller('/admin/products')
@Roles(['admin'])
@ApiSecurity(ApiKey)
export class ProductController {
  @Get()
  list(): string[] {
    return []
  }
}
`,
    )

    const { lines, diagnostics } = await diagnose(app.root)

    expect(lines).toEqual([
      expect.stringMatching(
        /^error ZNIGHT033 src\/catalog\/product\.controller\.ts:\d+ Duplicate operation id "product\.list": GET \/admin\/products \(ProductController\.list\) and GET \/products \(ProductController\.list\)$/,
      ),
    ])
    expect(diagnostics[0]?.hints?.join('\n')).toContain("@ApiOperation({ operationId: '")
  })

  it('ZNIGHT036: a scope that the security scheme does not declare', async () => {
    const app = copyOfTheApp()
    app.edit(
      'src/api.ts',
      '/** A back-office key',
      `/** The identity provider of the partners. */
export const OAuth = securityScheme('oauth2', {
  type: 'oauth2',
  flows: { clientCredentials: { tokenUrl: 'https://id.example.com/token', scopes: { 'orders:read': 'Read the orders' } } },
})

/** A back-office key`,
    )
    app.edit(
      'src/orders/order.controller.ts',
      '@ApiSecurity(ApiKey)',
      "@ApiSecurity(ApiKey, { scheme: OAuth, scopes: ['orders:export'] })",
    )
    app.edit(
      'src/orders/order.controller.ts',
      "import { ApiKey } from '../api.js'",
      "import { ApiKey, OAuth } from '../api.js'",
    )

    const { lines } = await diagnose(app.root)

    expect(lines).toEqual([
      expect.stringMatching(
        /^error ZNIGHT036 src\/orders\/order\.controller\.ts:\d+ The scope "orders:export" is not declared by the flows of "oauth2"$/,
      ),
    ])
  })
})
