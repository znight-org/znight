/** UI pages: CSP, escaping, pinned CDN assets (their SRI hashes are checked with ZNIGHT_NETWORK=1). */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { cdnUrl, findLocalPackage, renderUiPage, UI_PACKAGES } from '../src/ui.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

describe('findLocalPackage', () => {
  // an installed @scalar/api-reference: its exports map does not export "./package.json"
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-ui-')))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'node_modules/@scalar/api-reference')
  fs.mkdirSync(path.join(dir, 'dist/browser'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: '@scalar/api-reference',
      version: '1.75.1',
      type: 'module',
      exports: { '.': { import: './dist/index.js' }, './style.css': './dist/style.css' },
    }),
  )
  fs.writeFileSync(path.join(dir, 'dist/index.js'), 'export {}\n')
  fs.writeFileSync(path.join(dir, 'dist/browser/standalone.js'), '// stub\n')
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"app","type":"module"}')
  const base = pathToFileURL(path.join(root, 'package.json')).href

  it('finds a package whose exports map hides its package.json (Bun)', () => {
    expect(findLocalPackage(UI_PACKAGES.scalar, [base])).toEqual({ dir, version: '1.75.1' })
    expect(findLocalPackage(UI_PACKAGES.swagger, [base])).toBeUndefined()
  })

  it.skipIf(Bun.which('node') === null)('finds it on Node.js too', () => {
    const script = `const { findLocalPackage, UI_PACKAGES } = await import(${JSON.stringify(
      pathToFileURL(path.resolve(import.meta.dir, '../src/ui.ts')).href,
    )})\nprocess.stdout.write(JSON.stringify(findLocalPackage(UI_PACKAGES.scalar, [${JSON.stringify(base)}]) ?? null))`
    const output = execFileSync('node', ['--input-type=module', '--eval', script], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({ dir, version: '1.75.1' })
  })
})

describe('renderUiPage', () => {
  it('escapes the inline configuration and allows the inline script by hash only', () => {
    const page = renderUiPage({
      kind: 'scalar',
      documentUrl: '/openapi.json',
      assetsBase: undefined,
      title: 'A <b>title</b>',
      config: { title: '</script><script>alert(1)</script>' },
      connect: ['https://api.example.com'],
    })
    expect(page.html).not.toContain('</script><script>alert(1)')
    expect(page.html).toContain('<title>A &lt;b&gt;title&lt;/b&gt;</title>')
    const inline = /<script>(.*)<\/script>/.exec(page.html)?.[1] ?? ''
    expect(page.csp).toBe(
      [
        "default-src 'none'",
        `script-src 'self' https://cdn.jsdelivr.net 'sha256-${createHash('sha256').update(inline).digest('base64')}'`,
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "img-src 'self' data: https:",
        "font-src 'self' data: https://cdn.jsdelivr.net",
        "connect-src 'self' https://api.example.com",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    )
  })

  it('pins the CDN assets with SRI and serves local assets without CDN', () => {
    const cdn = renderUiPage({
      kind: 'swagger',
      documentUrl: '/o.json',
      assetsBase: undefined,
      title: 't',
      config: {},
      connect: [],
    })
    for (const asset of UI_PACKAGES.swagger.assets) {
      expect(cdn.html).toContain(
        `${cdnUrl(UI_PACKAGES.swagger, asset)}" integrity="${asset.integrity}" crossorigin="anonymous"`,
      )
    }
    const local = renderUiPage({
      kind: 'scalar',
      documentUrl: '/o.json',
      assetsBase: '/docs/_assets/scalar@1.2.3',
      title: 't',
      config: {},
      connect: [],
    })
    expect(local.html).toContain('<script src="/docs/_assets/scalar@1.2.3/standalone.js"></script>')
    expect(local.csp).not.toContain('jsdelivr')
  })
})

describe.skipIf(process.env['ZNIGHT_NETWORK'] !== '1')('pinned CDN assets (network)', () => {
  for (const pkg of Object.values(UI_PACKAGES)) {
    for (const asset of pkg.assets) {
      it(`${pkg.name}@${pkg.version}/${asset.file} matches its SRI hash`, async () => {
        const response = await fetch(cdnUrl(pkg, asset))
        expect(response.status).toBe(200)
        const digest = createHash('sha384')
          .update(new Uint8Array(await response.arrayBuffer()))
          .digest('base64')
        expect(`sha384-${digest}`).toBe(asset.integrity)
      }, 30_000)
    }
  }
})
