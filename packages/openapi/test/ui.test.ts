/** UI pages: CSP, escaping, pinned CDN assets (their SRI hashes are checked with ZNIGHT_NETWORK=1). */
import { createHash } from 'node:crypto'

import { cdnUrl, renderUiPage, UI_PACKAGES } from '../src/ui.ts'
import { describe, expect, test as it } from 'bun:test'

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
