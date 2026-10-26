/**
 * A minimal stand-in for `HttpPlugin` (`@znight/http`): named `'http'`, it routes the controllers
 * of `metadata.extensions.http` in memory and implements the `inject()` contract of `TestApp`.
 */
import type { Plugin, PluginContext } from '@znight/core'
import type { HttpInjectResult, InjectRequest } from '../../src/index.ts'
import type { HttpRouteLike } from './app.ts'

interface ControllerLike {
  readonly token: string
  readonly routes: readonly HttpRouteLike[]
}

interface Route {
  readonly method: string
  readonly pattern: readonly string[]
  readonly controller: string
  readonly definition: HttpRouteLike
}

export interface FakeHttpPlugin extends Plugin {
  readonly name: 'http'
  readonly calls: string[]
  readonly requests: (InjectRequest & { readonly method: string })[]
  inject(request: InjectRequest & { readonly method: string }): Promise<HttpInjectResult>
}

/** A response without `bytes` (TestApp derives them from `body`). */
function response(status: number, payload: unknown): HttpInjectResult {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
    json: <T>() => JSON.parse(body) as T,
  }
}

export function fakeHttp(): FakeHttpPlugin {
  const routes: Route[] = []
  const calls: string[] = []
  const requests: (InjectRequest & { readonly method: string })[] = []
  let context: PluginContext | undefined
  return {
    name: 'http',
    calls,
    requests,
    register() {
      calls.push('register')
    },
    onBootstrap(ctx) {
      calls.push('onBootstrap')
      context = ctx
      const http = (ctx.metadata.extensions as { http?: { controllers: readonly ControllerLike[] } } | undefined)?.http
      for (const controller of http?.controllers ?? []) {
        for (const definition of controller.routes) {
          routes.push({
            method: definition.method,
            pattern: definition.fullPath.split('/').filter(Boolean),
            controller: controller.token,
            definition,
          })
        }
      }
    },
    onStart() {
      calls.push('onStart')
    },
    onStop() {
      calls.push('onStop')
    },
    onDispose() {
      calls.push('onDispose')
    },
    async inject(request) {
      requests.push(request)
      if (context === undefined) throw new Error('not bootstrapped')
      const segments = request.url.split('?')[0]?.split('/').filter(Boolean) ?? []
      for (const route of routes) {
        if (route.method !== request.method || route.pattern.length !== segments.length) continue
        const params: Record<string, string> = {}
        const matches = route.pattern.every((part, index) => {
          if (part.startsWith(':')) {
            params[part.slice(1)] = segments[index] as string
            return true
          }
          return part === segments[index]
        })
        if (!matches) continue
        const ctx = context
        try {
          const result = await ctx.container.runInScope(() => {
            const controller = ctx.container.get(route.controller) as never
            return route.definition.invoke(controller, { params, body: request.body })
          })
          return response(result === undefined ? 404 : 200, result)
        } catch (error) {
          return response(500, { message: (error as Error).message })
        }
      }
      return response(404, { message: 'Not Found' })
    },
  }
}
