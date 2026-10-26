/**
 * Media types of files: a small extension table for downloads and `type/*` patterns for upload
 * filters. This module is **pure** (no imports, no I/O): the compiler extension validates the
 * `mimeTypes` option of `@UploadedFile` with it.
 */

/** Common extensions → media type (text types get `charset=utf-8` in {@link contentTypeFor}). */
const TYPES: Readonly<Record<string, string>> = {
  // text
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  htm: 'text/html',
  html: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  jsonld: 'application/ld+json',
  webmanifest: 'application/manifest+json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  ics: 'text/calendar',
  vtt: 'text/vtt',
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  // audio / video
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  // fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  // documents and archives
  pdf: 'application/pdf',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  wasm: 'application/wasm',
  bin: 'application/octet-stream',
}

/** Default media type of files without a known extension. */
export const OCTET_STREAM = 'application/octet-stream'

/**
 * Media type of a file name from its extension (`report.pdf` → `application/pdf`, text types with
 * `; charset=utf-8`), `undefined` when the extension is unknown.
 */
export function contentTypeFor(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) return undefined
  const separator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
  if (dot < separator) return undefined
  const extension = filename.slice(dot + 1).toLowerCase()
  // own keys only: `.constructor` / `.__proto__` must not resolve to `Object.prototype` members
  if (!Object.hasOwn(TYPES, extension)) return undefined
  const type = TYPES[extension] as string
  return isTextual(type) ? `${type}; charset=utf-8` : type
}

function isTextual(type: string): boolean {
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/ld+json' ||
    type === 'application/manifest+json' ||
    type === 'application/xml' ||
    type === 'application/yaml' ||
    type === 'image/svg+xml'
  )
}

/** `type/subtype` token characters (RFC 9110). */
const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+"
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}$`)

/**
 * Whether `pattern` is a valid media type filter: `type/subtype`, `type/*` or `*\/*`
 * (case-insensitive, without parameters).
 */
export function isMediaTypePattern(pattern: string): boolean {
  if (!MEDIA_TYPE.test(pattern)) return false
  const [type, subtype] = pattern.split('/') as [string, string]
  // `*` is only a wildcard on its own: `image/*`, `*/*` (`*/png` and `image/png*` are rejected)
  if (type.includes('*') && type !== '*') return false
  if (subtype.includes('*') && subtype !== '*') return false
  return type !== '*' || subtype === '*'
}

/** The essence of a media type: lower-case `type/subtype` without parameters (`Text/Plain; charset=x` → `text/plain`). */
export function mediaTypeEssence(type: string): string {
  const separator = type.indexOf(';')
  return (separator === -1 ? type : type.slice(0, separator)).trim().toLowerCase()
}

/** Whether the media type `type` (parameters ignored) matches one of `patterns` (`image/png`, `image/*`, `*\/*`). */
export function matchesMediaType(type: string, patterns: readonly string[]): boolean {
  const essence = mediaTypeEssence(type)
  const slash = essence.indexOf('/')
  if (slash <= 0 || slash === essence.length - 1) return false
  const major = essence.slice(0, slash)
  for (const raw of patterns) {
    const pattern = raw.toLowerCase()
    if (pattern === '*/*' || pattern === essence) return true
    if (pattern.endsWith('/*') && pattern.slice(0, -2) === major) return true
  }
  return false
}
