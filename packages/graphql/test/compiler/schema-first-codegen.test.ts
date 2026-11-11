/**
 * graphql-codegen interop (RFC 0007 §4.3): `test/fixtures/codegen/graphql.generated.ts` is the
 * verbatim output of graphql-codegen 7.4.6 (`typescript` 6.1.2 + `typescript-resolvers` 6.1.1,
 * `codegen.yml`: custom scalars mapped to the `scalar<T>()` types, `enumValues: 'keep'`) for
 * `event.graphql`. Resolvers typed with it (`Scalars['X']['output']`, `Maybe<T>`, `InputMaybe<T>`,
 * the `XxxArgs` types, intersections with interface types, `__typename` unions) pass the coverage
 * and conformance checks, type-check with the generated module, and run.
 */
import type { CompilerExtension } from '@znight/compiler'
import type { ZnightMetadata } from '@znight/core'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TestApp } from '@znight/testing'

import graphql from '../../src/compiler/index.ts'
import { GraphQLPlugin } from '../../src/index.ts'
import { executeOperation } from '../../src/testing.ts'
import { captureLogger } from '../support/app.ts'
import {
  analyzeSchemaFirst,
  cleanupApps,
  compileApp,
  render,
  SCHEMA_FIRST_CODES,
  tempApp,
  typecheck,
} from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const FIXTURES = path.resolve(import.meta.dir, '../fixtures/codegen')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

function files(resolver = fixture('event.resolver.ts')): Record<string, string> {
  return {
    'src/event.graphql': fixture('event.graphql'),
    'src/graphql.generated.ts': fixture('graphql.generated.ts'),
    'src/ids.ts': fixture('ids.ts'),
    'src/event.resolver.ts': resolver,
  }
}

describe('graphql-codegen types', () => {
  it('pass coverage and conformance, type-check with the generated module, and run', async () => {
    const app = tempApp(files())
    const extension = graphql.configure({ schema: 'src/**/*.graphql' }) as unknown as CompilerExtension
    const result = await compileApp(app.root, { mode: 'build', extensions: [extension] })
    expect(render({ root: app.root, diagnostics: result.diagnostics }, SCHEMA_FIRST_CODES)).toEqual([])
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    expect(typecheck(app, [path.relative(app.root, result.outFile)])).toEqual([])

    const generated = (await import(pathToFileURL(result.outFile).href)) as { metadata: ZnightMetadata }
    await using test = await TestApp.create({
      metadata: generated.metadata,
      plugins: [GraphQLPlugin.configure({ http: false })],
      logger: captureLogger(),
    })
    const res = await executeOperation(test, {
      query: `{
        event(id: "evt_1") { eventId title status startsAt tags owner { name } }
        events(filter: { status: PUBLISHED }) { id }
        node(id: "u1") { __typename id ... on User { name } }
      }`,
    })
    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({
      event: {
        eventId: 'evt_1',
        title: 'Launch',
        status: 'PUBLISHED',
        startsAt: '2026-11-03T18:00:00.000Z',
        tags: ['release'],
        owner: { name: 'Ada' },
      },
      events: [{ id: '1' }],
      node: { __typename: 'User', id: 'u1', name: 'Ada' },
    })
    const created = await executeOperation(test, {
      query: `mutation {
        ok: createEvent(input: { title: "Party" }) { __typename ... on Event { status eventId } }
        ko: createEvent(input: { title: " " }) { __typename ... on ValidationRejection { fields } }
      }`,
    })
    expect(created.errors).toBeUndefined()
    expect(created.data).toEqual({
      ok: { __typename: 'Event', status: 'DRAFT', eventId: 'evt_2' },
      ko: { __typename: 'ValidationRejection', fields: ['title'] },
    })
    const invalid = await executeOperation(test, { query: '{ event(id: "1") { id } }' })
    expect(invalid.errors?.[0]?.message).toContain('An event id starts with evt_')
  }, 60_000)

  it('still catches a resolver that does not conform to the SDL', async () => {
    const resolver = fixture('event.resolver.ts')
      .replace('): Promise<Event[]> {', '): Promise<Maybe<Event>[]> {')
      .replace("event(@Args('id') id: QueryEventArgs['id'])", "event(@Args('id') id: QueryNodeArgs['id'])")
    const result = await analyzeSchemaFirst(files(resolver))
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'ZNIGHT068').map(d => d.message)).toEqual([
      "parameter 'id' of EventResolver.event is string, which does not accept every EventId (Query.event(id:))",
      'EventResolver.events returns a list of Event | null, which may be null, but the items of Query.events ([Event!]!) are Event! (non-null)',
    ])
  })
})
