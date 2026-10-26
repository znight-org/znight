import * as express from '../src/adapters/express.ts'
import * as fastify from '../src/adapters/fastify.ts'
import * as hono from '../src/adapters/hono.ts'
import * as node from '../src/adapters/node.ts'
import * as entry from '../src/index.ts'
import * as path from '../src/path.ts'
import { describe, expect, it } from 'bun:test'

describe('public entries', () => {
  it('exports the runtime API from the root entry', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'All',
      'BadGatewayException',
      'BadRequestException',
      'Body',
      'ConflictException',
      'Controller',
      'Ctx',
      'Delete',
      'ForbiddenException',
      'GatewayTimeoutException',
      'Get',
      'GoneException',
      'Head',
      'Header',
      'Headers',
      'HttpCode',
      'HttpException',
      'HttpPlugin',
      'HttpResponse',
      'HttpTokens',
      'InternalServerErrorException',
      'MethodNotAllowedException',
      'NotFoundException',
      'NotImplementedException',
      'Options',
      'Param',
      'Patch',
      'PayloadTooLargeException',
      'Post',
      'Put',
      'Query',
      'Req',
      'Res',
      'ServiceUnavailableException',
      'TooManyRequestsException',
      'UnauthorizedException',
      'UnprocessableEntityException',
      'UnsupportedMediaTypeException',
      'UseGuard',
      'UseInterceptor',
      'Validate',
      'ValidationException',
      'coerce',
      'createRouteDecorator',
      'isHttpException',
      'isHttpResponse',
      'isJsonType',
      'isStandardSchema',
      'isValidStatus',
      'nodeAdapter',
      'parseBody',
      'parseMediaType',
      'parseQuery',
      'statusText',
      'toIssueDetail',
      'validate',
    ])
  })

  it('keeps the compiler contract helpers stable', () => {
    expect(Object.keys(entry.coerce).sort()).toEqual([
      'array',
      'bigint',
      'boolean',
      'date',
      'enum',
      'integer',
      'number',
      'optional',
      'string',
    ])
    expect(typeof entry.validate).toBe('function')
    expect(entry.HttpTokens).toEqual({
      Context: '@znight/http#HttpContext',
      RequestId: '@znight/http#RequestId',
      Plugin: '@znight/http#HttpPlugin',
    })
  })

  it('exports the path grammar from @znight/http/path', () => {
    expect(Object.keys(path).sort()).toEqual([
      'RoutePathError',
      'WILDCARD_PARAM',
      'checkRoutePath',
      'compareRoutePaths',
      'compareStrings',
      'decodePathValue',
      'joinPaths',
      'matchRoutePath',
      'normalizePath',
      'parseRoutePath',
      'toFastifyPath',
      'toHonoPath',
      'toRegExpSource',
    ])
  })

  it('exports one factory per adapter subpath', () => {
    expect(Object.keys(node)).toEqual(['nodeAdapter'])
    expect(Object.keys(fastify)).toEqual(['fastifyAdapter'])
    expect(Object.keys(express)).toEqual(['expressAdapter'])
    expect(Object.keys(hono)).toEqual(['honoAdapter'])
  })

  it('declares the package manifest', async () => {
    const manifest = (await import('../package.json')).default as { znight: unknown; exports: Record<string, unknown> }
    expect(manifest.znight).toEqual({
      apiVersion: 1,
      compiler: '@znight/http/compiler',
      provides: [
        { export: 'HttpContext', plugin: 'HttpPlugin', scope: 'request' },
        { export: 'RequestId', plugin: 'HttpPlugin', scope: 'request' },
        { export: 'HttpPlugin', plugin: 'HttpPlugin', scope: 'singleton' },
      ],
    })
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './path',
      './node',
      './fastify',
      './express',
      './hono',
      './package.json',
    ])
  })
})
