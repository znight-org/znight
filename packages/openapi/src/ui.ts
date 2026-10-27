/**
 * API reference pages (Scalar by default, Swagger UI as an option, §8.3 of RFC 0002): an HTML page
 * whose inline script is fixed at boot (allowed by hash in its own Content-Security-Policy), with
 * the UI assets served from `node_modules` or from a pinned CDN with Subresource Integrity.
 */
import type { JsonValue } from './types.ts'

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The supported UIs. */
export type UiKind = 'scalar' | 'swagger'

/** An asset of a UI package. */
export interface UiAsset {
  /** Path in the package. */
  readonly file: string
  /** SRI of the pinned CDN copy. */
  readonly integrity: string
  readonly kind: 'script' | 'style'
}

/** A UI package pinned by this release (bumped by Renovate; checked by a network test). */
export interface UiPackage {
  readonly name: string
  readonly version: string
  readonly assets: readonly UiAsset[]
}

/** jsDelivr. */
export const CDN_ORIGIN = 'https://cdn.jsdelivr.net'

/** Pinned versions and SRI hashes of the UI assets. */
export const UI_PACKAGES: Readonly<Record<UiKind, UiPackage>> = Object.freeze({
  scalar: Object.freeze({
    name: '@scalar/api-reference',
    version: '1.75.1',
    assets: Object.freeze([
      {
        file: 'dist/browser/standalone.js',
        integrity: 'sha384-G+2Q2i9l3PPfmYkk0b4BAIUrs7xb/DNaTL1wCYYab4c9dIKlCyiqzC0Qx3eq9Wf6',
        kind: 'script' as const,
      },
    ]),
  }),
  swagger: Object.freeze({
    name: 'swagger-ui-dist',
    version: '5.33.1',
    assets: Object.freeze([
      {
        file: 'swagger-ui.css',
        integrity: 'sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW',
        kind: 'style' as const,
      },
      {
        file: 'swagger-ui-bundle.js',
        integrity: 'sha384-ZPehFMQommnnuaZ4rpxgkgTT2DKFVp4hZC/7pLit+9Lek9T1YGSo23eHFbvNkXkw',
        kind: 'script' as const,
      },
    ]),
  }),
})

/** URL of a pinned asset on the CDN. */
export function cdnUrl(pkg: UiPackage, asset: UiAsset): string {
  return `${CDN_ORIGIN}/npm/${pkg.name}@${pkg.version}/${asset.file}`
}

/** An installed UI package. */
export interface LocalPackage {
  readonly dir: string
  readonly version: string
}

/**
 * Finds an installed UI package: from `@znight/openapi` (it is an optional peer), then from the
 * working directory. `undefined` when it is not installed or misses an asset. The same on Node.js and
 * Bun, whatever the exports map of the package says (`@scalar/api-reference` does not export its
 * `package.json`).
 */
export function findLocalPackage(pkg: UiPackage, from: readonly string[] = defaultBases()): LocalPackage | undefined {
  for (const base of from) {
    for (const manifest of manifestCandidates(pkg.name, base)) {
      const found = readLocalPackage(pkg, manifest)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Where the manifest of `name` may be, seen from `base`: the `package.json` subpath when it resolves
 * (Bun always resolves it, Node.js only when the exports map exports it), then `<dir>/<name>/package.json`
 * in the `node_modules` directories the resolution searches.
 */
function manifestCandidates(name: string, base: string): string[] {
  let require: ReturnType<typeof createRequire>
  try {
    require = createRequire(base)
  } catch {
    return []
  }
  const candidates: string[] = []
  try {
    candidates.push(require.resolve(`${name}/package.json`))
  } catch {
    // not installed, or an exports map without "./package.json"
  }
  for (const dir of require.resolve.paths(name) ?? []) candidates.push(join(dir, name, 'package.json'))
  return [...new Set(candidates)]
}

function readLocalPackage(pkg: UiPackage, manifest: string): LocalPackage | undefined {
  try {
    if (!existsSync(manifest)) return undefined
    const { name, version } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
    if (name !== pkg.name || typeof version !== 'string') return undefined
    const dir = dirname(manifest)
    return pkg.assets.every(asset => existsSync(join(dir, asset.file))) ? { dir, version } : undefined
  } catch {
    // unreadable manifest: try the next candidate
    return undefined
  }
}

function defaultBases(): string[] {
  return [import.meta.url, pathToFileURL(join(process.cwd(), 'package.json')).href]
}

/** What the page needs. */
export interface UiPageInput {
  readonly kind: UiKind
  /** URL of the JSON document, prefix included (`/api/openapi.json`). */
  readonly documentUrl: string
  /** Base URL of the local assets (`/api/docs/_assets/scalar@1.75.1`), `undefined` for the CDN. */
  readonly assetsBase: string | undefined
  readonly title: string
  /** User configuration (JSON-serialisable), merged over the defaults. */
  readonly config: Readonly<Record<string, JsonValue>>
  /** Origins the UI may call ("try it"): the absolute servers of the document. */
  readonly connect: readonly string[]
}

/** A rendered page. */
export interface UiPage {
  readonly html: string
  readonly csp: string
}

/** The HTML page of the UI and its Content-Security-Policy. */
export function renderUiPage(input: UiPageInput): UiPage {
  const pkg = UI_PACKAGES[input.kind]
  const local = input.assetsBase !== undefined
  const tags = pkg.assets.map(asset => {
    const url = local ? `${input.assetsBase}/${asset.file.slice(asset.file.lastIndexOf('/') + 1)}` : cdnUrl(pkg, asset)
    const integrity = local ? '' : ` integrity="${asset.integrity}" crossorigin="anonymous"`
    return asset.kind === 'style'
      ? `<link rel="stylesheet" href="${escapeHtml(url)}"${integrity}>`
      : `<script src="${escapeHtml(url)}"${integrity}></script>`
  })
  const styles = tags.filter(tag => tag.startsWith('<link'))
  const scripts = tags.filter(tag => tag.startsWith('<script'))
  const config =
    input.kind === 'scalar'
      ? { url: input.documentUrl, withDefaultFonts: false, telemetry: false, ...input.config }
      : { url: input.documentUrl, dom_id: '#swagger-ui', validatorUrl: null, ...input.config }
  const json = scriptJson(config)
  const inline =
    input.kind === 'scalar' ? `Scalar.createApiReference('#app', ${json})` : `window.ui = SwaggerUIBundle(${json})`
  const hash = `'sha256-${createHash('sha256').update(inline).digest('base64')}'`
  const container = input.kind === 'scalar' ? '<div id="app"></div>' : '<div id="swagger-ui"></div>'
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    ...styles,
    '</head>',
    '<body>',
    container,
    ...scripts,
    `<script>${inline}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
  const cdn = local ? '' : ` ${CDN_ORIGIN}`
  const connect = ["'self'", ...input.connect].join(' ')
  const csp = [
    "default-src 'none'",
    `script-src 'self'${cdn} ${hash}`,
    `style-src 'self' 'unsafe-inline'${cdn}`,
    "img-src 'self' data: https:",
    `font-src 'self' data:${cdn}`,
    `connect-src ${connect}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return { html, csp }
}

/** JSON safe inside an inline `<script>` (`<` escaped, line separators escaped). */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll(' ', '\\u2028').replaceAll(' ', '\\u2029')
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
