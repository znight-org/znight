import { HttpPlugin } from '@znight/http'

import { createTestApp } from './support/app.js'
import { expect, test as it } from 'bun:test'

function describeAccess(meta: Readonly<Record<string, unknown>>): string {
  if (meta.public === true) return 'public'
  if (Array.isArray(meta.roles)) return `roles ${meta.roles.join(' | ')}`
  if (meta.authenticated === true) return 'authenticated'
  return 'NO DECISION'
}

function describeLimit(meta: Readonly<Record<string, unknown>>): string {
  const limit = meta.rateLimit as { points: number; duration: number } | undefined
  return limit === undefined ? '' : `, ${limit.points} per ${limit.duration} s`
}

/**
 * Who can call what, as `HttpPlugin` registered it: the effective decision and the guard chain of
 * every route. A pull request that changes access changes the snapshot (`bun test -u` once reviewed).
 */
it('access matrix', async () => {
  await using app = await createTestApp()
  const matrix = app
    .get(HttpPlugin)
    .routes.filter(route => route.method !== 'HEAD')
    .map(
      route =>
        `${route.method} ${route.path} → ${describeAccess(route.meta)}${describeLimit(route.meta)} [${route.guards.join(', ')}]`,
    )
  expect(matrix).toMatchSnapshot()
})
