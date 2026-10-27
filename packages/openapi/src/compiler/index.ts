/**
 * `@znight/openapi/compiler`: the compiler extension of `@znight/openapi` (architecture §6.5),
 * loaded by `@znight/compiler` through `package.json#znight.compiler`.
 *
 * - `analyzeClass`: records the `@OpenApiDocument` class, checks where `@Api*` decorators are
 *   (ZNIGHT030);
 * - `validate`: builds the operation model from the route table of `@znight/http/compiler`, the
 *   handler signatures, their JSDoc and the type shapes, and reports ZNIGHT030–036;
 * - `generate`: `metadata.extensions.openapi` (README, "Compiler contract").
 *
 * This entry only `import type`s from `@znight/compiler` and `@znight/http/compiler` and never
 * loads the runtime of `@znight/openapi`.
 */
import type { CompilerExtension, DecoratorSpec } from '@znight/compiler'
import type { OpenApiStored } from './model.ts'

import { analyzeOpenApiClass } from './analyze.ts'
import { generateOpenApi } from './generate.ts'
import { EXTENSION_NAME, Ids } from './model.ts'
import { validateOpenApi } from './validate.ts'

export type { OpenApiStored } from './model.ts'

/** Decorators owned by the extension, by canonical identity (static / value arguments, §4.6). */
const decorators: Readonly<Record<string, DecoratorSpec>> = Object.freeze({
  [Ids.OpenApiDocument]: { targets: ['class'], params: ['value'] },
  [Ids.ApiOperation]: { targets: ['method'], params: ['static'] },
  [Ids.ApiTags]: { targets: ['class', 'method'], params: [], rest: 'static' },
  [Ids.ApiResponse]: { targets: ['method'], params: ['static', 'value'] },
  [Ids.ApiBody]: { targets: ['method'], params: ['value'] },
  [Ids.ApiQuery]: { targets: ['method'], params: ['static', 'static'] },
  [Ids.ApiHeader]: { targets: ['class', 'method'], params: ['static', 'static'] },
  [Ids.ApiSecurity]: { targets: ['class', 'method'], params: [], rest: 'value' },
  [Ids.ApiExclude]: { targets: ['class', 'method'], params: [] },
})

/** The `@znight/openapi` compiler extension. */
const openapi: CompilerExtension<OpenApiStored> = Object.freeze({
  apiVersion: 1,
  name: EXTENSION_NAME,
  decorators,
  analyzeClass: analyzeOpenApiClass,
  validate: validateOpenApi,
  generate: generateOpenApi,
})

export default openapi
