/** The injectable `OpenApi` external and the YAML serialisation. */
import type { OpenApiOperationView } from './build.ts'
import type { OpenApiObject } from './types.ts'

import { ErrorCode, type TypedToken, ZnightError } from '@znight/core'

/**
 * The document of the application, provided by `OpenApiPlugin` (a singleton external declared in
 * the manifest of `@znight/openapi`).
 *
 * ```ts
 * @Injectable()
 * export class GatewayRegistration implements OnReady {
 *   constructor(private readonly openapi: OpenApi, private readonly gateway: GatewayClient) {}
 *   async onReady(): Promise<void> {
 *     await this.gateway.publish(await this.openapi.json())
 *   }
 * }
 * ```
 */
export abstract class OpenApi {
  /** The frozen document (built on the first call in `'first-request'` mode, or when the plugin is disabled). */
  abstract document(): Promise<OpenApiObject>
  /** The served JSON text (2 spaces, final newline). */
  abstract json(): Promise<string>
  /** The YAML text (optional peer `yaml`). */
  abstract yaml(): Promise<string>
  /** Static view of the operations, without any schema conversion. */
  abstract readonly operations: readonly OpenApiOperationView[]
}

/** Tokens of the externals provided by `OpenApiPlugin` (declared in the package manifest). */
export const OpenApiTokens: {
  /** The {@link OpenApi} singleton. */
  readonly OpenApi: TypedToken<OpenApi>
} = Object.freeze({ OpenApi: '@znight/openapi#OpenApi' })

/** YAML text of a document (`yaml` is an optional peer, loaded lazily). */
export async function toYaml(document: OpenApiObject): Promise<string> {
  let module: { stringify?: (value: unknown, options?: Record<string, unknown>) => string }
  try {
    module = (await import('yaml')) as typeof module
  } catch (error) {
    throw new ZnightError(ErrorCode.InvalidOpenApiDefinition, 'YAML output needs the optional peer dependency "yaml"', {
      cause: error,
      hints: ['npm install yaml'],
    })
  }
  if (typeof module.stringify !== 'function') {
    throw new ZnightError(ErrorCode.InvalidOpenApiDefinition, 'The installed "yaml" package has no stringify()', {
      hints: ['npm install yaml@2'],
    })
  }
  return module.stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 })
}
