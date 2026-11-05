/**
 * The types of `@whatwg-node/fetch` (a dependency of graphql-yoga: the Yoga driver, the recipe), mapped
 * through `paths` in `tsconfig.json` and `test/tsconfig.json`: the package's own typings start with
 * `/// <reference lib="dom" />`, which would replace the Bun and Node.js globals of the whole test
 * program with the DOM ones. The same declarations, on the globals already there.
 */
export interface FormDataLimits {
  fieldNameSize?: number
  fieldSize?: number
  fields?: number
  fileSize?: number
  files?: number
  parts?: number
  headerSize?: number
}

export declare const fetch: typeof globalThis.fetch
export declare const Request: typeof globalThis.Request
export declare const Response: typeof globalThis.Response
export declare const Headers: typeof globalThis.Headers
export declare const FormData: typeof globalThis.FormData
export declare const ReadableStream: typeof globalThis.ReadableStream
export declare const Blob: typeof globalThis.Blob
export declare const File: typeof globalThis.File
export declare const URL: typeof globalThis.URL
export declare const URLSearchParams: typeof globalThis.URLSearchParams

export declare const createFetch: (opts?: {
  useNodeFetch?: boolean
  formDataLimits?: FormDataLimits
  skipPonyfill?: boolean
}) => {
  fetch: typeof globalThis.fetch
  Request: typeof globalThis.Request
  Response: typeof globalThis.Response
  Headers: typeof globalThis.Headers
  FormData: typeof globalThis.FormData
  ReadableStream: typeof globalThis.ReadableStream
  WritableStream: typeof globalThis.WritableStream
  TransformStream: typeof globalThis.TransformStream
  CompressionStream: typeof globalThis.CompressionStream
  DecompressionStream: typeof globalThis.DecompressionStream
  TextDecoderStream: typeof globalThis.TextDecoderStream
  TextEncoderStream: typeof globalThis.TextEncoderStream
  Blob: typeof globalThis.Blob
  File: typeof globalThis.File
  btoa: typeof globalThis.btoa
  TextEncoder: typeof globalThis.TextEncoder
  TextDecoder: typeof globalThis.TextDecoder
  URL: typeof globalThis.URL
  URLSearchParams: typeof globalThis.URLSearchParams
}
