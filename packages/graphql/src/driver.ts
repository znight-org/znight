/**
 * The GraphQL driver contract (RFC 0009 §4.3): a GraphQL server (GraphQL Yoga, Apollo Server, a
 * third party's) serving the schema of `GraphQLPlugin` on top of its {@link GraphQLEngine}. Znight
 * owns the schema, the execution and the lifecycle; the driver owns the protocol, its plugins and
 * its subscription transport. Types only.
 */
import type { Container, CoreLogger } from '@znight/core'
import type { HttpPlugin, PluginRoute } from '@znight/http'
import type { GraphQLEngine } from './engine.ts'

/** What {@link GraphQLDriver.routes} receives. */
export interface GraphQLDriverRoutesContext {
  /** The `path` option: the endpoint path, relative to the `HttpPlugin` prefix (`/graphql`). */
  readonly path: string
  /** The absolute endpoint path, the prefix included (`/api/graphql`). */
  readonly endpoint: string
}

/**
 * A route of a driver: a plugin route of `HttpPlugin` without `meta`, `guards` and `bodyLimit`,
 * which `GraphQLPlugin` adds from its `http` option (`bodyLimit` on the routes that are not `GET`).
 */
export type GraphQLDriverRoute = Pick<PluginRoute, 'method' | 'path' | 'name' | 'handler'>

/** What {@link GraphQLDriver.start} receives besides the engine. */
export interface GraphQLDriverContext {
  /** The application logger. */
  readonly logger: CoreLogger
  readonly container: Container
  /** The `HttpPlugin` of the application, when registered (its adapter, for server-mounted drivers). */
  readonly http: HttpPlugin | undefined
}

/**
 * A GraphQL driver, given to `GraphQLPlugin.configure({ driver })`. A route-mounted driver returns
 * its routes, which run in `HttpPlugin`'s pipeline (request scope, hooks, guards, CORS, drain) and
 * call the engine from there; a server-mounted one has no routes and attaches itself to the
 * adapter in `start()`. One driver serves one application at a time.
 */
export interface GraphQLDriver {
  /**
   * The driver's name (`yoga`, `apollo`...): `GraphQLOperationEvent.driver`, logs and errors.
   * `builtin` is reserved for the built-in transport.
   */
  readonly name: string
  /**
   * The routes `HttpPlugin` serves for the driver, with the `http` option's meta, guards and body
   * limit applied by the plugin. Called once per application, possibly before {@link start}: the
   * handlers MUST NOT use the engine before the first request. Not called with `http: false`.
   */
  routes?(context: GraphQLDriverRoutesContext): readonly GraphQLDriverRoute[]
  /**
   * Called in `GraphQLPlugin.onBootstrap`, once the engine is built: create the server. A failure
   * fails the boot (ZNIGHT066, the original error as `cause`).
   */
  start(engine: GraphQLEngine, context: GraphQLDriverContext): void | Promise<void>
  /** Called in `GraphQLPlugin.onStop`, after the engine ended its subscriptions: drain and stop the server. */
  stop?(): void | Promise<void>
}
