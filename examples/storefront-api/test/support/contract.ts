import type { OpenApiObject } from '@znight/openapi'
import type { ResponseIssue } from '@znight/openapi/testing'

import { validateResponse } from '@znight/openapi/testing'

/**
 * Checks each line of a newline-delimited JSON response (`application/x-ndjson`) against the schema
 * documented for that media type: `validateResponse()` checks the status and the media type, but
 * only parses JSON bodies as a whole.
 */
export function validateNdjsonLines(
  document: OpenApiObject,
  { path, response }: { readonly path: string; readonly response: { readonly body: string } },
): ResponseIssue[] {
  const schema = document.paths?.[path]?.get?.responses?.['200']
  const itemSchema =
    schema !== undefined && 'content' in schema ? schema.content?.['application/x-ndjson']?.schema : undefined
  if (itemSchema === undefined) throw new Error(`GET ${path} documents no application/x-ndjson response`)
  // a one-operation document answering the schema of one line, with the same components
  const lines: OpenApiObject = {
    ...document,
    paths: {
      '/line': {
        get: {
          responses: { 200: { description: 'One line', content: { 'application/json': { schema: itemSchema } } } },
        },
      },
    },
  }
  return response.body
    .split('\n')
    .filter(line => line !== '')
    .flatMap((body, index) =>
      validateResponse(lines, {
        method: 'GET',
        path: '/line',
        response: { status: 200, headers: { 'content-type': 'application/json' }, body },
      }).map(issue => ({ ...issue, path: `line ${index + 1}: ${issue.path}` })),
    )
}
