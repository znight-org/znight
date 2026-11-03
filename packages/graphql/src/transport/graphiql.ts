/**
 * The GraphiQL page (RFC 0005 §8.3, §8.9): served on `GET path` with `accept: text/html` when the
 * `graphiql` option is on (default: `NODE_ENV === 'development'`). React and GraphiQL load from a
 * pinned CDN with Subresource Integrity; the inline script is fixed at boot and allowed by hash in
 * the page's own `content-security-policy`, which overrides the strict API default of RFC 0001 on
 * this response only.
 */
import { createHash } from 'node:crypto'

/** jsDelivr. */
export const GRAPHIQL_CDN = 'https://cdn.jsdelivr.net'

/** A pinned CDN asset. */
export interface GraphiQLAsset {
  readonly url: string
  /** Subresource Integrity of the pinned file. */
  readonly integrity: string
  readonly kind: 'script' | 'style'
}

/**
 * The assets of the page: GraphiQL 3 (the last major with a UMD build) on React 18. Bumped by hand,
 * with their SRI hashes (`sha384` of the files on the CDN).
 */
export const GRAPHIQL_ASSETS: readonly GraphiQLAsset[] = Object.freeze([
  {
    url: `${GRAPHIQL_CDN}/npm/graphiql@3.9.0/graphiql.min.css`,
    integrity: 'sha384-QMux00XgRtwRLSYIY3kw2rj1ovk5AuuliAchk+HSQbqdbGFnz9GYuqIlOqxhwCE2',
    kind: 'style',
  },
  {
    url: `${GRAPHIQL_CDN}/npm/react@18.3.1/umd/react.production.min.js`,
    integrity: 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z',
    kind: 'script',
  },
  {
    url: `${GRAPHIQL_CDN}/npm/react-dom@18.3.1/umd/react-dom.production.min.js`,
    integrity: 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1',
    kind: 'script',
  },
  {
    url: `${GRAPHIQL_CDN}/npm/graphiql@3.9.0/graphiql.min.js`,
    integrity: 'sha384-8NGfVj4CVlqHajlZj+bPJT4thxPMHMJYn7DWK2CvtopLd02E7qsPHazniBYvVjOO',
    kind: 'script',
  },
])

/** The rendered page. */
export interface GraphiQLPage {
  readonly html: string
  readonly csp: string
}

/** `<`, `>` and `&` escaped: JSON safe inside a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The GraphiQL page of the endpoint `endpoint` (an absolute path, prefix included) and its CSP. */
export function renderGraphiQL(endpoint: string): GraphiQLPage {
  const tags = GRAPHIQL_ASSETS.map(asset =>
    asset.kind === 'style'
      ? `<link rel="stylesheet" href="${escapeHtml(asset.url)}" integrity="${asset.integrity}" crossorigin="anonymous">`
      : `<script src="${escapeHtml(asset.url)}" integrity="${asset.integrity}" crossorigin="anonymous"></script>`,
  )
  const inline = [
    `const fetcher = GraphiQL.createFetcher({ url: ${scriptJson(endpoint)} })`,
    `ReactDOM.createRoot(document.getElementById('graphiql')).render(React.createElement(GraphiQL, { fetcher }))`,
  ].join('\n')
  const hash = `'sha256-${createHash('sha256').update(inline).digest('base64')}'`
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>GraphiQL</title>',
    '<style>body { margin: 0; } #graphiql { height: 100dvh; }</style>',
    ...tags.filter(tag => tag.startsWith('<link')),
    '</head>',
    '<body>',
    '<div id="graphiql">Loading GraphiQL…</div>',
    ...tags.filter(tag => tag.startsWith('<script')),
    `<script>${inline}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
  const csp = [
    "default-src 'none'",
    `script-src ${GRAPHIQL_CDN} ${hash}`,
    // GraphiQL and CodeMirror set inline styles
    `style-src 'unsafe-inline' ${GRAPHIQL_CDN}`,
    `font-src data: ${GRAPHIQL_CDN}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
  return { html, csp }
}
