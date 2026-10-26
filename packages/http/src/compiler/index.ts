/**
 * `@znight/http/compiler`: the compiler extension of `@znight/http` (architecture §6.5), loaded by
 * `@znight/compiler` through `package.json#znight.compiler`.
 *
 * - `analyzeClass`: `@Controller` classes become providers; their decorated methods become routes
 *   (paths, parameters with type-based coercion or Standard Schema validation, guards,
 *   interceptors, status, headers, `createRouteDecorator` metadata);
 * - `validate`: route paths, `:param` ↔ `@Param`, duplicate routes (ZNIGHT007);
 * - `generate`: `metadata.extensions.http` with one `invoke` function per route (README,
 *   "Compiler contract").
 *
 * This entry only `import type`s from `@znight/compiler` and never loads the HTTP runtime.
 */
import type { CompilerExtension, DecoratorSpec } from '@znight/compiler'
import type { HttpControllerData } from './model.ts'

import { analyzeHttpClass, EXTENSION_NAME } from './analyze.ts'
import { generateHttp } from './generate.ts'
import { Ids, ROUTE_METHODS } from './model.ts'
import { validateHttp } from './validate.ts'

export type {
  CoercionPlan,
  HttpControllerData,
  HttpParamData,
  HttpRouteData,
  MetaEntry,
  ParamCoercion,
  ScalarCoercion,
} from './model.ts'

const ROUTE: DecoratorSpec = { targets: ['method'], params: ['static'] }
const NAME_OR_SCHEMA: DecoratorSpec = { targets: ['parameter'], params: ['value', 'value'] }
const NO_ARGUMENT: DecoratorSpec = { targets: ['parameter'], params: [] }
const CLASS_REFS: DecoratorSpec = { targets: ['class', 'method'], params: [], rest: 'value' }

/** Decorators owned by the extension, by canonical identity (static / value arguments, §4.6). */
const decorators: Readonly<Record<string, DecoratorSpec>> = Object.freeze({
  [Ids.Controller]: { targets: ['class'], params: ['static'] },
  ...Object.fromEntries([...ROUTE_METHODS.keys()].map(identity => [identity, ROUTE])),
  [Ids.Param]: NAME_OR_SCHEMA,
  [Ids.Query]: NAME_OR_SCHEMA,
  [Ids.Body]: { targets: ['parameter'], params: ['value'] },
  [Ids.Headers]: { targets: ['parameter'], params: ['static'] },
  [Ids.Req]: NO_ARGUMENT,
  [Ids.Res]: NO_ARGUMENT,
  [Ids.Ctx]: NO_ARGUMENT,
  [Ids.HttpCode]: { targets: ['method'], params: ['static'] },
  [Ids.Header]: { targets: ['method'], params: ['static', 'static'] },
  [Ids.UseGuard]: CLASS_REFS,
  [Ids.UseInterceptor]: CLASS_REFS,
  [Ids.Validate]: { targets: ['method'], params: ['value'] },
})

/** The `@znight/http` compiler extension. */
const http: CompilerExtension<HttpControllerData> = Object.freeze({
  apiVersion: 1,
  name: EXTENSION_NAME,
  decorators,
  analyzeClass: analyzeHttpClass,
  validate: validateHttp,
  generate: generateHttp,
})

export default http
